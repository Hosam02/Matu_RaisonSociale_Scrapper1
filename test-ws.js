import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:3005/status');

// State to track if we've already requested login
let loginRequested = false;
let loginInProgress = false;

ws.on('open', () => {
  console.log('✅ Connected to WebSocket');
  
  // Send ping
  ws.send(JSON.stringify({ type: 'ping' }));
  
  // Get initial status after 1 second
  setTimeout(() => {
    console.log('📊 Requesting initial status...');
    ws.send(JSON.stringify({ type: 'get_status' }));
  }, 1000);
});

ws.on('message', (data) => {
  const message = JSON.parse(data.toString());
  console.log('📩 Received:', message);
  
  if (message.type === 'status') {
    const status = message.data;
    console.log('Status:', status.status);
    console.log('Logged in:', status.isLoggedIn);
    
    // Check if we need to login
    if (!status.isLoggedIn && !loginRequested && !loginInProgress) {
      console.log('🔍 Not logged in, checking if we should request login...');
      
      // Don't request login if it's already in progress or error state
      if (status.status !== 'connecting' && status.status !== 'error') {
        console.log('🔑 Requesting login...');
        loginRequested = true;
        loginInProgress = true;
        ws.send(JSON.stringify({ type: 'request_login' }));
      } else if (status.status === 'connecting') {
        console.log('⏳ Login already in progress, waiting...');
        loginInProgress = true;
      } else if (status.status === 'error') {
        console.log('❌ Previous login error detected, you may want to try manually');
      }
    } else if (status.isLoggedIn) {
      console.log('✅ Already logged in! Session age:', status.sessionAge, 'seconds');
      loginRequested = true; // Mark as requested since we're already logged in
      loginInProgress = false;
    } else if (loginRequested && status.status === 'connecting') {
      console.log('⏳ Login in progress...');
      loginInProgress = true;
    } else if (loginRequested && status.status === 'connected' && status.isLoggedIn) {
      console.log('🎉 Login successful!');
      loginInProgress = false;
    } else if (loginRequested && status.status === 'error') {
      console.log('❌ Login failed:', status.error);
      loginRequested = false;
      loginInProgress = false;
    }
  }
  
  if (message.type === 'login_started') {
    console.log('🔐 Login process started:', message.message);
    loginInProgress = true;
  }
  
  if (message.type === 'pong') {
    console.log('🏓 Pong received');
  }
  
  if (message.type === 'error') {
    console.log('❌ Error from server:', message.message);
  }
  
  if (message.type === 'welcome') {
    console.log('👋 Welcome message:', message.message);
    console.log('Client ID:', message.clientId);
  }
});

ws.on('error', (error) => {
  console.error('❌ WebSocket error:', error);
});

ws.on('close', (code, reason) => {
  console.log(`🔌 Disconnected - Code: ${code}, Reason: ${reason}`);
});

// Handle process termination
process.on('SIGINT', () => {
  console.log('\n👋 Closing WebSocket connection...');
  if (ws.readyState === WebSocket.OPEN) {
    ws.close();
  }
  process.exit(0);
});

console.log('🚀 WebSocket test client started. Press Ctrl+C to exit.');