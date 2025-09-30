const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|mp4|avi|mov|pdf|doc|docx|txt/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('File type not allowed'));
    }
  }
});

// Serve static files
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Store active rooms and users
const rooms = new Map();
const users = new Map();

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/room/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

// File upload endpoint
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  res.json({
    success: true,
    file: {
      name: req.file.originalname,
      path: `/uploads/${req.file.filename}`,
      type: req.file.mimetype,
      size: req.file.size
    }
  });
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Create a new room
  socket.on('create-room', (userName) => {
    const roomId = uuidv4();
    const room = {
      id: roomId,
      users: new Map(),
      createdAt: new Date()
    };
    
    rooms.set(roomId, room);
    users.set(socket.id, { id: socket.id, userName, roomId });
    
    socket.join(roomId);
    socket.emit('room-created', roomId);
    
    console.log(`Room created: ${roomId} by ${userName}`);
  });

  // Join an existing room
  socket.on('join-room', (data) => {
    const { roomId, userName } = data;
    const room = rooms.get(roomId);
    
    if (!room) {
      socket.emit('error', 'Room not found');
      return;
    }
    
    // Add user to room
    const user = { id: socket.id, userName, roomId };
    room.users.set(socket.id, user);
    users.set(socket.id, user);
    
    socket.join(roomId);
    
    // Notify other users in the room
    socket.to(roomId).emit('user-joined', {
      userId: socket.id,
      userName,
      users: Array.from(room.users.values())
    });
    
    // Send current room users to the new user
    socket.emit('room-joined', {
      roomId,
      users: Array.from(room.users.values())
    });
    
    console.log(`${userName} joined room: ${roomId}`);
  });

  // WebRTC signaling
  socket.on('offer', (data) => {
    socket.to(data.target).emit('offer', {
      offer: data.offer,
      sender: socket.id
    });
  });

  socket.on('answer', (data) => {
    socket.to(data.target).emit('answer', {
      answer: data.answer,
      sender: socket.id
    });
  });

  socket.on('ice-candidate', (data) => {
    socket.to(data.target).emit('ice-candidate', {
      candidate: data.candidate,
      sender: socket.id
    });
  });

  // Text chat messages
  socket.on('send-message', (data) => {
    const user = users.get(socket.id);
    if (user) {
      socket.to(user.roomId).emit('new-message', {
        userId: socket.id,
        userName: user.userName,
        message: data.message,
        timestamp: new Date()
      });
    }
  });

  // File sharing
  socket.on('send-file', (data) => {
    const user = users.get(socket.id);
    if (user) {
      socket.to(user.roomId).emit('new-file', {
        userId: socket.id,
        userName: user.userName,
        file: data.file,
        timestamp: new Date()
      });
    }
  });

  // Typing indicator
  socket.on('typing-start', () => {
    const user = users.get(socket.id);
    if (user) {
      socket.to(user.roomId).emit('user-typing', {
        userId: socket.id,
        userName: user.userName
      });
    }
  });

  socket.on('typing-stop', () => {
    const user = users.get(socket.id);
    if (user) {
      socket.to(user.roomId).emit('user-stop-typing', socket.id);
    }
  });

  // Toggle video/audio
  socket.on('toggle-media', (data) => {
    const user = users.get(socket.id);
    if (user) {
      socket.to(user.roomId).emit('user-media-toggle', {
        userId: socket.id,
        type: data.type,
        state: data.state
      });
    }
  });

  // Get available rooms
  socket.on('get-rooms', () => {
    const availableRooms = Array.from(rooms.entries())
      .filter(([id, room]) => room.users.size > 0)
      .map(([id, room]) => ({
        id: id,
        userCount: room.users.size,
        createdAt: room.createdAt
      }));
    
    socket.emit('rooms-list', availableRooms);
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    
    if (user) {
      const room = rooms.get(user.roomId);
      if (room) {
        room.users.delete(socket.id);
        
        // Notify other users
        socket.to(user.roomId).emit('user-left', socket.id);
        
        // Remove room if empty
        if (room.users.size === 0) {
          rooms.delete(user.roomId);
        }
      }
      
      users.delete(socket.id);
    }
    
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});