let socket;
let localStream;
let peers = {};
let currentRoomId;
let userName;
let isVideoOn = true;
let isAudioOn = true;
let cameras = [];
let currentCameraIndex = 0;
let isFlashOn = false;
let typingTimer;

// Initialize when page loads
document.addEventListener('DOMContentLoaded', function() {
    if (window.location.pathname === '/') {
        initializeHomePage();
    } else {
        initializeRoomPage();
    }
});

function initializeHomePage() {
    socket = io();
    
    // Listen for room creation
    socket.on('room-created', (roomId) => {
        window.location.href = `/room/${roomId}`;
    });
    
    // Listen for rooms list
    socket.on('rooms-list', (rooms) => {
        const roomsList = document.getElementById('roomsList');
        roomsList.innerHTML = '';
        
        rooms.forEach(room => {
            const roomElement = document.createElement('div');
            roomElement.className = 'room-item';
            roomElement.innerHTML = `
                <strong>Room: ${room.id.substring(0, 8)}...</strong>
                <br>Users: ${room.userCount}
            `;
            roomElement.onclick = () => {
                document.getElementById('roomId').value = room.id;
            };
            roomsList.appendChild(roomElement);
        });
    });
    
    // Load available rooms
    refreshRooms();
}

function initializeRoomPage() {
    socket = io();
    setupRoomEventListeners();
    initializeMedia();
    setupControlListeners();
    
    // Extract room ID from URL
    const pathParts = window.location.pathname.split('/');
    currentRoomId = pathParts[pathParts.length - 1];
    
    if (currentRoomId) {
        document.getElementById('roomIdDisplay').textContent = `Room: ${currentRoomId}`;
        
        // Get user name from session storage or prompt
        userName = sessionStorage.getItem('userName') || prompt('Enter your name:');
        sessionStorage.setItem('userName', userName);
        
        socket.emit('join-room', { roomId: currentRoomId, userName });
    }
}

function setupRoomEventListeners() {
    socket.on('room-joined', (data) => {
        console.log('Joined room:', data);
        updateUserCount(data.users.length);
    });
    
    socket.on('user-joined', (data) => {
        console.log('User joined:', data.userName);
        updateUserCount(data.users.length);
    });
    
    socket.on('user-left', (userId) => {
        if (peers[userId]) {
            peers[userId].close();
            delete peers[userId];
        }
        removeVideoElement(userId);
        updateUserCount(Object.keys(peers).length + 1);
    });
    
    socket.on('offer', handleOffer);
    socket.on('answer', handleAnswer);
    socket.on('ice-candidate', handleIceCandidate);
    
    socket.on('new-message', handleNewMessage);
    socket.on('new-file', handleNewFile);
    socket.on('user-typing', handleUserTyping);
    socket.on('user-stop-typing', handleUserStopTyping);
    socket.on('user-media-toggle', handleUserMediaToggle);
}

async function initializeMedia() {
    try {
        await getCameras();
        localStream = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: cameras[currentCameraIndex] ? { exact: cameras[currentCameraIndex].deviceId } : true },
            audio: true
        });
        
        addVideoElement(socket.id, localStream, userName, true);
    } catch (error) {
        console.error('Error accessing media devices:', error);
        alert('Error accessing camera/microphone. Please check permissions.');
    }
}

async function getCameras() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        cameras = devices.filter(device => device.kind === 'videoinput');
        console.log('Available cameras:', cameras);
    } catch (error) {
        console.error('Error enumerating devices:', error);
    }
}

function addVideoElement(userId, stream, name, isLocal = false) {
    const videoGrid = document.getElementById('videoGrid');
    
    // Remove existing video element for this user
    removeVideoElement(userId);
    
    const videoContainer = document.createElement('div');
    videoContainer.className = 'video-container';
    videoContainer.id = `video-${userId}`;
    
    const video = document.createElement('video');
    video.srcObject = stream;
    video.autoplay = true;
    video.playsInline = true;
    video.muted = isLocal;
    
    const userNameLabel = document.createElement('div');
    userNameLabel.className = 'user-name';
    userNameLabel.textContent = name + (isLocal ? ' (You)' : '');
    
    videoContainer.appendChild(video);
    videoContainer.appendChild(userNameLabel);
    videoGrid.appendChild(videoContainer);
}

function removeVideoElement(userId) {
    const existingVideo = document.getElementById(`video-${userId}`);
    if (existingVideo) {
        existingVideo.remove();
    }
}

function updateUserCount(count) {
    document.getElementById('userCount').textContent = `${count} user${count !== 1 ? 's' : ''}`;
}

// WebRTC Functions
async function createPeerConnection(userId) {
    const configuration = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' }
        ]
    };
    
    const peerConnection = new RTCPeerConnection(configuration);
    
    // Add local stream to peer connection
    if (localStream) {
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });
    }
    
    // Handle incoming stream
    peerConnection.ontrack = (event) => {
        const [remoteStream] = event.streams;
        addVideoElement(userId, remoteStream, 'Remote User');
    };
    
    // Handle ICE candidates
    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice-candidate', {
                target: userId,
                candidate: event.candidate
            });
        }
    };
    
    return peerConnection;
}

async function handleOffer(data) {
    const peerConnection = await createPeerConnection(data.sender);
    peers[data.sender] = peerConnection;
    
    await peerConnection.setRemoteDescription(data.offer);
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    
    socket.emit('answer', {
        target: data.sender,
        answer: answer
    });
}

async function handleAnswer(data) {
    const peerConnection = peers[data.sender];
    if (peerConnection) {
        await peerConnection.setRemoteDescription(data.answer);
    }
}

async function handleIceCandidate(data) {
    const peerConnection = peers[data.sender];
    if (peerConnection) {
        await peerConnection.addIceCandidate(data.candidate);
    }
}

// Chat Functions
function sendMessage() {
    const messageInput = document.getElementById('messageInput');
    const message = messageInput.value.trim();
    
    if (message) {
        socket.emit('send-message', { message });
        addMessageToChat(message, userName, true);
        messageInput.value = '';
        stopTyping();
    }
}

function handleNewMessage(data) {
    addMessageToChat(data.message, data.userName, false);
}

function addMessageToChat(message, sender, isOwn) {
    const chatMessages = document.getElementById('chatMessages');
    const messageElement = document.createElement('div');
    messageElement.className = `message ${isOwn ? 'own' : 'other'}`;
    
    messageElement.innerHTML = `
        <strong>${sender}:</strong>
        <p>${message}</p>
        <small>${new Date().toLocaleTimeString()}</small>
    `;
    
    chatMessages.appendChild(messageElement);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// File Sharing
document.getElementById('fileInput').addEventListener('change', async function(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    const formData = new FormData();
    formData.append('file', file);
    
    try {
        const response = await fetch('/upload', {
            method: 'POST',
            body: formData
        });
        
        const result = await response.json();
        
        if (result.success) {
            socket.emit('send-file', { file: result.file });
            addFileToChat(result.file, userName, true);
        }
    } catch (error) {
        console.error('Error uploading file:', error);
        alert('Error uploading file');
    }
    
    e.target.value = '';
});

function handleNewFile(data) {
    addFileToChat(data.file, data.userName, false);
}

function addFileToChat(file, sender, isOwn) {
    const chatMessages = document.getElementById('chatMessages');
    const messageElement = document.createElement('div');
    messageElement.className = `message ${isOwn ? 'own' : 'other'}`;
    
    const fileType = file.type.split('/')[0];
    let fileContent = '';
    
    if (fileType === 'image') {
        fileContent = `<img src="${file.path}" alt="${file.name}" style="max-width: 200px; max-height: 200px;">`;
    } else if (fileType === 'video') {
        fileContent = `<video src="${file.path}" controls style="max-width: 200px; max-height: 200px;"></video>`;
    } else {
        fileContent = `<a href="${file.path}" download="${file.name}">${file.name}</a>`;
    }
    
    messageElement.innerHTML = `
        <strong>${sender} shared a file:</strong>
        <div class="file-message">${fileContent}</div>
        <small>${new Date().toLocaleTimeString()}</small>
    `;
    
    chatMessages.appendChild(messageElement);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Typing Indicator
function handleTyping() {
    socket.emit('typing-start');
    
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
        stopTyping();
    }, 1000);
}

function stopTyping() {
    socket.emit('typing-stop');
}

function handleUserTyping(data) {
    const typingIndicator = document.getElementById('typingIndicator');
    typingIndicator.textContent = `${data.userName} is typing...`;
}

function handleUserStopTyping(userId) {
    const typingIndicator = document.getElementById('typingIndicator');
    typingIndicator.textContent = '';
}

// Control Functions
function setupControlListeners() {
    document.getElementById('toggleVideo').addEventListener('click', toggleVideo);
    document.getElementById('toggleAudio').addEventListener('click', toggleAudio);
    document.getElementById('switchCamera').addEventListener('click', switchCamera);
    document.getElementById('toggleFlash').addEventListener('click', toggleFlash);
    document.getElementById('shareScreen').addEventListener('click', shareScreen);
    document.getElementById('leaveRoom').addEventListener('click', leaveRoom);
    
    // Enter key for sending messages
    document.getElementById('messageInput').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            sendMessage();
        }
    });
}

function toggleVideo() {
    if (localStream) {
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
            videoTrack.enabled = !videoTrack.enabled;
            isVideoOn = videoTrack.enabled;
            document.getElementById('toggleVideo').textContent = isVideoOn ? '📹' : '📹❌';
            
            socket.emit('toggle-media', {
                type: 'video',
                state: videoTrack.enabled
            });
        }
    }
}

function toggleAudio() {
    if (localStream) {
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) {
            audioTrack.enabled = !audioTrack.enabled;
            isAudioOn = audioTrack.enabled;
            document.getElementById('toggleAudio').textContent = isAudioOn ? '🎤' : '🎤❌';
            
            socket.emit('toggle-media', {
                type: 'audio',
                state: audioTrack.enabled
            });
        }
    }
}

async function switchCamera() {
    if (cameras.length < 2) {
        alert('Only one camera available');
        return;
    }
    
    currentCameraIndex = (currentCameraIndex + 1) % cameras.length;
    
    try {
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
        }
        
        localStream = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: cameras[currentCameraIndex].deviceId },
            audio: true
        });
        
        // Update local video element
        const localVideo = document.querySelector(`#video-${socket.id} video`);
        if (localVideo) {
            localVideo.srcObject = localStream;
        }
        
        // Update all peer connections
        Object.values(peers).forEach(peer => {
            const videoSender = peer.getSenders().find(sender => 
                sender.track && sender.track.kind === 'video'
            );
            
            if (videoSender) {
                const videoTrack = localStream.getVideoTracks()[0];
                videoSender.replaceTrack(videoTrack);
            }
        });
    } catch (error) {
        console.error('Error switching camera:', error);
    }
}

function toggleFlash() {
    if (localStream) {
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack && typeof videoTrack.applyConstraints === 'function') {
            const constraints = {
                advanced: [{ torch: !isFlashOn }]
            };
            
            videoTrack.applyConstraints(constraints)
                .then(() => {
                    isFlashOn = !isFlashOn;
                    document.getElementById('toggleFlash').textContent = isFlashOn ? '💡' : '💡❌';
                })
                .catch(error => {
                    console.error('Error toggling flash:', error);
                    alert('Flash not supported on this device');
                });
        } else {
            alert('Flash not supported on this device');
        }
    }
}

async function shareScreen() {
    try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: true
        });
        
        // Replace video track in all peer connections
        const videoTrack = screenStream.getVideoTracks()[0];
        
        Object.values(peers).forEach(peer => {
            const videoSender = peer.getSenders().find(sender => 
                sender.track && sender.track.kind === 'video'
            );
            
            if (videoSender) {
                videoSender.replaceTrack(videoTrack);
            }
        });
        
        // Handle when screen sharing stops
        videoTrack.onended = () => {
            switchCamera(); // Switch back to camera
        };
        
    } catch (error) {
        console.error('Error sharing screen:', error);
    }
}

function leaveRoom() {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
    }
    
    Object.values(peers).forEach(peer => peer.close());
    
    window.location.href = '/';
}

function handleUserMediaToggle(data) {
    const videoElement = document.querySelector(`#video-${data.userId} video`);
    if (videoElement) {
        if (data.type === 'video') {
            videoElement.style.opacity = data.state ? '1' : '0.5';
        }
    }
}

// Home Page Functions
function createRoom() {
    const userNameInput = document.getElementById('userName');
    const name = userNameInput.value.trim();
    
    if (!name) {
        alert('Please enter your name');
        return;
    }
    
    sessionStorage.setItem('userName', name);
    document.getElementById('loading').classList.remove('hidden');
    socket.emit('create-room', name);
}

function joinRoom() {
    const userNameInput = document.getElementById('joinUserName');
    const roomIdInput = document.getElementById('roomId');
    
    const name = userNameInput.value.trim();
    const roomId = roomIdInput.value.trim();
    
    if (!name || !roomId) {
        alert('Please enter both your name and room ID');
        return;
    }
    
    sessionStorage.setItem('userName', name);
    document.getElementById('loading').classList.remove('hidden');
    window.location.href = `/room/${roomId}`;
}

function refreshRooms() {
    socket.emit('get-rooms');
}