import WebSocket from 'ws';

const WS_URL = 'ws://localhost:3006/status';
let ws = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY = 2000; // 2 seconds

// State to track if we've already requested login
let loginRequested = false;
let loginInProgress = false;
let reconnectTimer = null;
let statusCheckInterval = null;

function connect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.log('❌ Max reconnection attempts reached. Please check if server is running.');
    return;
  }

  console.log(`🔄 Connecting to WebSocket... (Attempt ${reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS})`);
  
  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log('✅ Connected to WebSocket');
    reconnectAttempts = 0; // Reset reconnect attempts on successful connection
    
    // Clear any existing reconnect timer
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    
    // Send ping
    ws.send(JSON.stringify({ type: 'ping' }));
    
    // Get initial status after 1 second
    setTimeout(() => {
      console.log('📊 Requesting initial status...');
      ws.send(JSON.stringify({ type: 'get_status' }));
    }, 1000);
    
    // Set up periodic status check every 15 seconds
    if (statusCheckInterval) {
      clearInterval(statusCheckInterval);
    }
    statusCheckInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        console.log('⏰ Periodic status check...');
        ws.send(JSON.stringify({ type: 'get_status' }));
      }
    }, 15000);
  });

  ws.on('message', (data) => {
    const message = JSON.parse(data.toString());
    console.log('📩 Received:', message);
    
    if (message.type === 'status') {
      const status = message.data;
      console.log('Status:', status.status);
      console.log('Logged in:', status.isLoggedIn);
      
      // Check if we're logged out - this is the key addition for auto-reconnect
      if (!status.isLoggedIn) {
        console.log('⚠️ Detected logged out state!');
        
        // Reset login flags
        loginRequested = false;
        loginInProgress = false;
        
        // Auto-reconnect logic
        if (status.status === 'disconnected' || status.status === 'error') {
          console.log('🔄 Server is disconnected/error, attempting to trigger login...');
          
          // Small delay before requesting login to avoid race conditions
          setTimeout(() => {
            if (ws && ws.readyState === WebSocket.OPEN && !loginRequested && !loginInProgress) {
              console.log('🔑 Auto-requesting login due to logged out state...');
              loginRequested = true;
              loginInProgress = true;
              ws.send(JSON.stringify({ type: 'request_login' }));
            }
          }, 2000);
        }
      }
      
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
        if (status.browserLaunchTime) {
          console.log('   Browser launched:', new Date(status.browserLaunchTime).toLocaleString());
        }
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
    
    if (message.type === 'login_progress') {
      console.log('📈 Login progress:', message.message);
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
    
    // Clear intervals
    if (statusCheckInterval) {
      clearInterval(statusCheckInterval);
      statusCheckInterval = null;
    }
    
    // Reset states
    loginRequested = false;
    loginInProgress = false;
    
    // Attempt to reconnect
    reconnectAttempts++;
    console.log(`🔄 Scheduling reconnect in ${RECONNECT_DELAY/1000} seconds...`);
    
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }
    
    reconnectTimer = setTimeout(() => {
      connect();
    }, RECONNECT_DELAY);
  });
}

// Handle process termination
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down test client...');
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }
  if (statusCheckInterval) {
    clearInterval(statusCheckInterval);
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  }
  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught exception:', error);
});

// Start connection
console.log('🚀 WebSocket test client with auto-reconnect started. Press Ctrl+C to exit.');
connect();