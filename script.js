const API_URL = "https://functions.yandexcloud.net/d4etraj6pl3ep8uj8cd8";

const config = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        { 
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        { 
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ],
    iceCandidatePoolSize: 10
};

const state = {
    userId: null,
    userName: null,
    roomId: null,
    roomOwner: false,
    peerConnections: {},
    dataChannels: {},
    participants: [],
    files: [],
    transfers: [],
    activeTransfers: {},
    pendingFiles: {},
    sendingQueue: {},
    sendingInProgress: {},
    pendingCandidates: {},
    processedSignals: new Set(),
    lastPollTime: 0,
    chunkSize: 16384,
    updateInterval: null,
    signalInterval: null,
    pendingFileModal: null
};

const fileStore = localforage.createInstance({ name: "DropShare", storeName: "files" });
const historyStore = localforage.createInstance({ name: "DropShare", storeName: "history" });

document.addEventListener('DOMContentLoaded', () => {
    init();
    setupDragAndDrop();
});

async function init() {
    state.userId = 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    state.userName = generateShortName();
    
    await loadFiles();
    await loadHistory();
    
    if (!window.RTCPeerConnection) {
        showToast('Ваш браузер не поддерживает P2P передачу', 5000);
        document.getElementById('loadingText').textContent = 'Браузер не поддерживается';
        return;
    }
    
    await checkConnection();
    setTimeout(() => {
        document.getElementById('loading').style.display = 'none';
    }, 800);
}

function generateShortName() {
    const shortNames = ['Макс', 'Анна', 'Кэт', 'Ник', 'Тим', 'Ли', 'Дэн', 'Мия', 'Зоя', 'Лев', 'Ром', 'Ким', 'Джи', 'Эмма', 'Джо', 'Ай', 'Ви', 'Тэд', 'Мэй', 'Рэй'];
    const suffix = Math.random().toString(36).substring(2, 5).toUpperCase();
    return `${shortNames[Math.floor(Math.random() * shortNames.length)]}${suffix}`;
}

async function checkConnection() {
    try {
        const res = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'ping' })
        });
        updateConnectionStatus(res.ok);
        return res.ok;
    } catch {
        updateConnectionStatus(false);
        return false;
    }
}

function updateConnectionStatus(online) {
    const status = document.getElementById('connStatus');
    if (!status) return;
    status.style.display = 'flex';
    const dot = status.querySelector('.conn-dot');
    const text = status.querySelector('span');
    dot.className = online ? 'conn-dot online' : 'conn-dot offline';
    text.textContent = online ? 'Online' : 'Offline';
}

function showToast(msg, icon = 'info', duration = 2500) {
    const toast = document.getElementById('toast');
    const iconMap = { info: 'ℹ️', success: '✅', file: '📁' };
    const prefix = iconMap[icon] || '';
    toast.innerHTML = `${prefix} ${msg}`;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), duration);
}

function showLoading(text = 'Загрузка...') {
    document.getElementById('loading').style.display = 'flex';
    document.getElementById('loadingText').textContent = text;
}

function hideLoading() {
    document.getElementById('loading').style.display = 'none';
}

function setupDragAndDrop() {
    const zone = document.getElementById('fileZone');
    if (!zone) return;
    zone.addEventListener('dragover', (e) => {
        e.preventDefault();
        zone.classList.add('drag-over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', (e) => {
        e.preventDefault();
        zone.classList.remove('drag-over');
        handleFiles(e.dataTransfer.files);
    });
}

async function loadFiles() {
    const keys = await fileStore.keys();
    state.files = [];
    for (const key of keys) {
        const file = await fileStore.getItem(key);
        if (file) state.files.push(file);
    }
    renderFiles();
}

async function loadHistory() {
    const history = await historyStore.getItem('transfers');
    if (history) {
        state.transfers = history;
        renderHistory();
    }
}

async function saveFile(fileData) {
    await fileStore.setItem(fileData.id, fileData);
    state.files.push(fileData);
    renderFiles();
}

async function saveTransfer(transfer) {
    state.transfers.unshift(transfer);
    if (state.transfers.length > 100) state.transfers = state.transfers.slice(0, 100);
    await historyStore.setItem('transfers', state.transfers);
    renderHistory();
}

function renderFiles() {
    const container = document.getElementById('filesList');
    if (!container) return;
    if (state.files.length === 0) {
        container.innerHTML = `<div class="empty-state"><i class="fas fa-folder-open"></i><p>Нет сохранённых файлов</p></div>`;
        return;
    }
    container.innerHTML = state.files.map(file => `
        <div class="file-card">
            <div class="file-icon"><i class="fas ${getFileIcon(file.type)}"></i></div>
            <div class="file-details">
                <div class="file-name">${escapeHtml(file.name)}</div>
                <div class="file-meta">${formatSize(file.size)} • ${new Date(file.savedAt).toLocaleTimeString()}</div>
            </div>
            <div class="file-actions">
                <button class="mini-btn download" onclick="downloadFile('${file.id}')"><i class="fas fa-download"></i></button>
                <button class="mini-btn delete" onclick="deleteFile('${file.id}')"><i class="fas fa-trash"></i></button>
            </div>
        </div>
    `).join('');
}

function renderHistory() {
    const container = document.getElementById('historyList');
    if (!container) return;
    if (state.transfers.length === 0) {
        container.innerHTML = `<div class="empty-state"><i class="fas fa-history"></i><p>История пуста</p></div>`;
        return;
    }
    container.innerHTML = state.transfers.map(t => `
        <div class="history-card">
            <div class="file-icon"><i class="fas ${t.type === 'sent' ? 'fa-arrow-up' : 'fa-arrow-down'}"></i></div>
            <div class="file-details">
                <div class="file-name">${escapeHtml(t.fileName)}</div>
                <div class="file-meta">${formatSize(t.fileSize)} • ${t.type === 'sent' ? 'Отправлено' : 'Получено'} ${new Date(t.timestamp).toLocaleTimeString()}</div>
            </div>
        </div>
    `).join('');
}

function renderParticipants() {
    const container = document.getElementById('participantsList');
    if (!container) return;
    if (state.participants.length === 0) {
        container.innerHTML = `<div class="empty-state"><i class="fas fa-users"></i><p>Ожидание участников...</p></div>`;
        return;
    }
    container.innerHTML = state.participants.map(p => {
        const isMe = p.id === state.userId;
        const channelState = state.dataChannels[p.id]?.readyState;
        const isConnected = channelState === 'open';
        return `
            <div class="participant-card ${isMe ? 'me' : ''}">
                <div class="participant-avatar" style="background: ${getColor(p.id)}">${getInitials(p.name || p.id)}</div>
                <div class="participant-info">
                    <div class="participant-name">
                        ${escapeHtml(p.name || p.id)} ${isMe ? '(Вы)' : ''}
                        ${p.isOwner ? '<span class="participant-badge">Создатель</span>' : ''}
                    </div>
                    <div class="participant-status">
                        <div class="status-dot ${isConnected ? '' : 'connecting'}"></div>
                        ${isConnected ? 'Соединение активно' : 'Подключение...'}
                    </div>
                </div>
                ${!isMe ? `
                    <div class="action-group">
                        <button class="icon-btn send" onclick="selectFileForUser('${p.id}', '${escapeHtml(p.name)}')" ${!isConnected ? 'disabled style="opacity:0.5"' : ''}>
                            <i class="fas fa-paper-plane"></i>
                        </button>
                        ${state.roomOwner ? `<button class="icon-btn kick" onclick="kickParticipant('${p.id}')"><i class="fas fa-user-slash"></i></button>` : ''}
                    </div>
                ` : ''}
            </div>
        `;
    }).join('');
}

function getFileIcon(type) {
    if (type?.startsWith('image/')) return 'fa-image';
    if (type?.startsWith('video/')) return 'fa-video';
    if (type?.startsWith('audio/')) return 'fa-music';
    return 'fa-file';
}

function formatSize(bytes) {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

async function downloadFile(id) {
    const file = state.files.find(f => f.id === id);
    if (!file) return;
    const blob = new Blob([new Uint8Array(file.data)], { type: file.type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.click();
    URL.revokeObjectURL(url);
}

async function deleteFile(id) {
    if (!confirm('Удалить файл?')) return;
    await fileStore.removeItem(id);
    state.files = state.files.filter(f => f.id !== id);
    renderFiles();
    showToast('Файл удалён', 'info');
}

function switchTab(tab) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    if (tab === 'users') {
        document.querySelector('.tab:first-child').classList.add('active');
        document.getElementById('usersTab').classList.add('active');
    } else if (tab === 'files') {
        document.querySelector('.tab:nth-child(2)').classList.add('active');
        document.getElementById('filesTab').classList.add('active');
    } else if (tab === 'history') {
        document.querySelector('.tab:nth-child(3)').classList.add('active');
        document.getElementById('historyTab').classList.add('active');
    }
}

async function createRoom() {
    showLoading('Создание комнаты...');
    try {
        const newCode = generateRoomCode(8);
        const res = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'createRoom', userId: state.userId, userName: state.userName, roomId: newCode })
        });
        const data = await res.json();
        if (data.success) {
            state.roomId = newCode;
            state.roomOwner = true;
            await startSession();
            showToast('Комната создана!', 'success');
            copyRoomCode();
        } else throw new Error(data.error);
    } catch (e) {
        showToast('Ошибка создания', 'info');
    } finally {
        hideLoading();
    }
}

function generateRoomCode(length = 8) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < length; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

async function joinRoom() {
    let code = document.getElementById('roomCode').value.trim().toUpperCase();
    if (!code || code.length < 6) {
        showToast('Введите код (6-8 символов)', 'info');
        return;
    }
    showLoading('Подключение...');
    try {
        const res = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'joinRoom', roomId: code, userId: state.userId, userName: state.userName })
        });
        const data = await res.json();
        if (data.success) {
            state.roomId = code;
            state.roomOwner = false;
            await startSession();
            showToast('Подключено!', 'success');
        } else throw new Error(data.error);
    } catch {
        showToast('Ошибка подключения', 'info');
    } finally {
        hideLoading();
    }
}

async function startSession() {
    document.getElementById('homeScreen').classList.remove('active');
    document.getElementById('mainScreen').classList.add('active');
    document.getElementById('currentRoomCode').textContent = state.roomId;
    startUpdates();
    await updateParticipants();
}

async function copyRoomCode() {
    await navigator.clipboard.writeText(state.roomId);
    showToast('Код скопирован', 'success');
}

async function shareRoomCode() {
    const url = `${window.location.origin}${window.location.pathname}#code=${state.roomId}`;
    if (navigator.share) {
        await navigator.share({ title: 'DropShare', text: `Код комнаты: ${state.roomId}`, url });
    } else {
        await navigator.clipboard.writeText(url);
        showToast('Ссылка скопирована', 'success');
    }
}

function startUpdates() {
    if (state.updateInterval) clearInterval(state.updateInterval);
    if (state.signalInterval) clearInterval(state.signalInterval);
    state.updateInterval = setInterval(updateParticipants, 3000);
    state.signalInterval = setInterval(pollSignals, 1000);
    setTimeout(() => { updateParticipants(); pollSignals(); }, 500);
}

async function updateParticipants() {
    if (!state.roomId) return;
    try {
        const res = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'getParticipants', roomId: state.roomId, userId: state.userId })
        });
        const data = await res.json();
        if (data.success) {
            const old = state.participants.map(p => p.id);
            const newIds = data.participants.map(p => p.id);
            state.participants = data.participants;
            if (JSON.stringify(old) !== JSON.stringify(newIds)) {
                renderParticipants();
                connectToNewParticipants(old, newIds);
            }
        }
    } catch (e) {}
}

function connectToNewParticipants(oldList, newList) {
    const newPeers = newList.filter(id => id !== state.userId && !oldList.includes(id) && !state.peerConnections[id]);
    newPeers.forEach(peerId => createPeerConnection(peerId));
    Object.keys(state.peerConnections).forEach(peerId => {
        if (!newList.includes(peerId) && peerId !== state.userId) cleanupPeerConnection(peerId);
    });
}

async function createPeerConnection(peerId) {
    if (state.peerConnections[peerId]) return;
    const pc = new RTCPeerConnection(config);
    state.peerConnections[peerId] = pc;
    
    const dc = pc.createDataChannel('fileTransfer');
    setupDataChannel(dc, peerId);
    state.dataChannels[peerId] = dc;
    
    pc.onicecandidate = (e) => {
        if (e.candidate) sendSignal(peerId, 'candidate', e.candidate);
    };
    
    pc.ondatachannel = (e) => {
        setupDataChannel(e.channel, peerId);
        state.dataChannels[peerId] = e.channel;
    };
    
    if (state.userId < peerId) {
        setTimeout(async () => {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            await sendSignal(peerId, 'offer', offer);
        }, 500);
    }
}

function setupDataChannel(channel, peerId) {
    channel.onopen = () => {
        renderParticipants();
        if (state.pendingFiles[peerId]?.length) {
            state.pendingFiles[peerId].forEach(f => sendFileToUser(f, peerId));
            delete state.pendingFiles[peerId];
        }
    };
    channel.onmessage = async (e) => {
        const data = JSON.parse(e.data);
        if (data.type === 'file_chunk') await handleFileChunk(data, peerId);
    };
}

let selectedUser = null;

function selectFileForUser(userId, userName) {
    selectedUser = { id: userId, name: userName };
    document.getElementById('fileInput').click();
}

async function handleFiles(files) {
    if (!files?.length) return;
    const file = files[0];
    if (selectedUser) {
        await sendFileToUser(file, selectedUser.id);
        selectedUser = null;
    } else {
        const peers = Object.keys(state.dataChannels).filter(id => state.dataChannels[id]?.readyState === 'open');
        if (!peers.length) {
            showToast('Нет активных подключений', 'info');
            return;
        }
        peers.forEach(pid => sendFileToUser(file, pid));
    }
}

async function sendFileToUser(file, targetId) {
    const dc = state.dataChannels[targetId];
    if (!dc || dc.readyState !== 'open') {
        if (!state.pendingFiles[targetId]) state.pendingFiles[targetId] = [];
        state.pendingFiles[targetId].push(file);
        showToast('Ожидание соединения...', 'info');
        return;
    }
    
    const fileId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    showToast(`Отправка: ${file.name}`, 'info');
    
    if (!state.sendingQueue[targetId]) state.sendingQueue[targetId] = [];
    state.sendingQueue[targetId].push({ fileId, file, targetId });
    processSendQueue(targetId);
}

async function processSendQueue(targetId) {
    if (state.sendingInProgress[targetId]) return;
    if (!state.sendingQueue[targetId]?.length) return;
    
    state.sendingInProgress[targetId] = true;
    const { fileId, file } = state.sendingQueue[targetId].shift();
    const dc = state.dataChannels[targetId];
    
    const totalChunks = Math.ceil(file.size / state.chunkSize);
    let offset = 0;
    let chunkIndex = 0;
    
    const sendNext = () => {
        if (offset >= file.size) {
            delete state.sendingInProgress[targetId];
            showToast(`Готово: ${file.name}`, 'success');
            saveTransfer({ type: 'sent', from: state.userId, fileName: file.name, fileSize: file.size, timestamp: Date.now() });
            processSendQueue(targetId);
            return;
        }
        
        const chunk = file.slice(offset, offset + state.chunkSize);
        const reader = new FileReader();
        reader.onload = (e) => {
            const chunkData = Array.from(new Uint8Array(e.target.result));
            const msg = JSON.stringify({
                type: 'file_chunk',
                fileId, fileName: file.name, fileSize: file.size, fileType: file.type,
                chunkIndex, totalChunks, data: chunkData
            });
            
            if (dc.bufferedAmount > 65536) {
                dc.onbufferedamountlow = () => {
                    dc.onbufferedamountlow = null;
                    dc.send(msg);
                    offset += state.chunkSize;
                    chunkIndex++;
                    sendNext();
                };
            } else {
                dc.send(msg);
                offset += state.chunkSize;
                chunkIndex++;
                sendNext();
            }
        };
        reader.readAsArrayBuffer(chunk);
    };
    
    dc.bufferedAmountLowThreshold = 65536;
    sendNext();
}

let pendingModalData = null;

async function handleFileChunk(data, fromId) {
    const id = data.fileId;
    if (!state.activeTransfers[id]) {
        state.activeTransfers[id] = {
            fileName: data.fileName, fileSize: data.fileSize, fileType: data.fileType,
            chunks: new Array(data.totalChunks), received: 0, total: data.totalChunks
        };
    }
    
    const t = state.activeTransfers[id];
    t.chunks[data.chunkIndex] = new Uint8Array(data.data);
    t.received++;
    
    if (t.received === t.total) {
        let size = 0;
        for (const c of t.chunks) size += c.length;
        const full = new Uint8Array(size);
        let offset = 0;
        for (const c of t.chunks) { full.set(c, offset); offset += c.length; }
        
        // Show modal instead of auto-save
        pendingModalData = {
            id,
            name: t.fileName,
            size: t.fileSize,
            type: t.fileType,
            data: Array.from(full),
            fromId
        };
        
        document.getElementById('modalFileName').innerText = `${t.fileName} (${formatSize(t.fileSize)})`;
        document.getElementById('fileModal').classList.add('active');
        
        delete state.activeTransfers[id];
    }
}

function modalDownload() {
    if (pendingModalData) {
        saveFile(pendingModalData);
        saveTransfer({
            type: 'received',
            from: pendingModalData.fromId,
            fileName: pendingModalData.name,
            fileSize: pendingModalData.size,
            timestamp: Date.now()
        });
        showToast(`Файл ${pendingModalData.name} сохранён`, 'file');
    }
    closeModal();
}

function closeModal() {
    document.getElementById('fileModal').classList.remove('active');
    pendingModalData = null;
}

async function pollSignals() {
    if (!state.roomId) return;
    try {
        const res = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'getSignals', roomId: state.roomId, userId: state.userId, timestamp: state.lastPollTime })
        });
        const data = await res.json();
        if (data.success && data.signals?.length) {
            state.lastPollTime = Date.now();
            for (const s of data.signals) await handleSignal(s);
        }
    } catch (e) {}
}

async function handleSignal(signal) {
    const id = `${signal.from}_${signal.type}_${Date.now()}`;
    if (state.processedSignals.has(id) || signal.from === state.userId) return;
    state.processedSignals.add(id);
    
    switch (signal.type) {
        case 'offer': await handleOffer(signal.from, signal.data); break;
        case 'answer': await handleAnswer(signal.from, signal.data); break;
        case 'candidate': await handleCandidate(signal.from, signal.data); break;
        case 'kicked':
            if (signal.to === state.userId) {
                showToast('Вас удалили', 'info');
                leaveRoom();
            }
            break;
    }
}

async function sendSignal(to, type, data) {
    if (!state.roomId) return;
    await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'signal', roomId: state.roomId, userId: state.userId, signal: { to, type, data } })
    });
}

async function handleOffer(peerId, offer) {
    let pc = state.peerConnections[peerId];
    if (!pc) {
        pc = new RTCPeerConnection(config);
        state.peerConnections[peerId] = pc;
        pc.onicecandidate = (e) => { if (e.candidate) sendSignal(peerId, 'candidate', e.candidate); };
        pc.ondatachannel = (e) => {
            setupDataChannel(e.channel, peerId);
            state.dataChannels[peerId] = e.channel;
        };
    }
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await sendSignal(peerId, 'answer', answer);
    if (state.pendingCandidates[peerId]) {
        for (const c of state.pendingCandidates[peerId]) {
            try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
        }
        delete state.pendingCandidates[peerId];
    }
}

async function handleAnswer(peerId, answer) {
    const pc = state.peerConnections[peerId];
    if (pc && pc.signalingState === 'have-local-offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
    }
}

async function handleCandidate(peerId, candidate) {
    const pc = state.peerConnections[peerId];
    if (!pc || !pc.remoteDescription) {
        if (!state.pendingCandidates[peerId]) state.pendingCandidates[peerId] = [];
        state.pendingCandidates[peerId].push(candidate);
        return;
    }
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
}

async function kickParticipant(id) {
    if (!confirm('Удалить участника?')) return;
    await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'kickParticipant', roomId: state.roomId, userId: state.userId, participantId: id })
    });
    showToast('Участник удалён', 'info');
    cleanupPeerConnection(id);
}

function cleanupPeerConnection(peerId) {
    if (state.peerConnections[peerId]) {
        state.peerConnections[peerId].close();
        delete state.peerConnections[peerId];
    }
    delete state.dataChannels[peerId];
    delete state.pendingFiles[peerId];
    delete state.sendingQueue[peerId];
    delete state.sendingInProgress[peerId];
}

async function leaveRoom() {
    if (!confirm('Выйти из комнаты?')) return;
    if (state.roomId) {
        await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'leaveRoom', roomId: state.roomId, userId: state.userId })
        });
    }
    cleanup();
    document.getElementById('mainScreen').classList.remove('active');
    document.getElementById('homeScreen').classList.add('active');
    document.getElementById('roomCode').value = '';
    showToast('Вы вышли', 'info');
}

function cleanup() {
    if (state.updateInterval) clearInterval(state.updateInterval);
    if (state.signalInterval) clearInterval(state.signalInterval);
    Object.values(state.peerConnections).forEach(pc => pc.close());
    state.peerConnections = {};
    state.dataChannels = {};
    state.activeTransfers = {};
    state.pendingFiles = {};
    state.sendingQueue = {};
    state.sendingInProgress = {};
    state.pendingCandidates = {};
    state.processedSignals.clear();
    state.roomId = null;
    state.roomOwner = false;
}

function getInitials(name) {
    return name.slice(0, 2).toUpperCase();
}

function getColor(id) {
    const colors = ['#a855f7', '#ec489a', '#f59e0b', '#10b981', '#3b82f6', '#ef4444', '#8b5cf6'];
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = ((hash << 5) - hash) + id.charCodeAt(i);
    return colors[Math.abs(hash) % colors.length];
}

document.getElementById('roomCode')?.addEventListener('input', function() {
    this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 8);
});
