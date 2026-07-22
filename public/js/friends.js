/**
 * friends.js — Friends List & Private Messaging Module
 */
const Friends = (() => {
  try {
    let sb = null;
    let socket = null;
    let currentUser = null;
    let friends = [];
    let openChatFriendId = null;
    let currentStrangerId = null;

    // DOM Elements
    const friendsBtn = document.getElementById('friends-btn');
    const closeFriendsBtn = document.getElementById('close-friends-btn');
    const friendsSidebar = document.getElementById('friends-sidebar');
    const friendTabs = document.querySelectorAll('.friend-tab');
    const listView = document.getElementById('friends-list-view');
    const requestsView = document.getElementById('friends-requests-view');
    const reqBadge = document.getElementById('friend-req-badge');
    const addFriendBtn = document.getElementById('add-friend-btn'); 

    const messengerWindow = document.getElementById('messenger-window');
    const closeMessengerBtn = document.getElementById('close-messenger-btn');
    const messengerMessages = document.getElementById('messenger-messages');
    const messengerForm = document.getElementById('messenger-form');
    const messengerInput = document.getElementById('messenger-input');
  

  // ── Init ────────────────────────────────────────────────────────────
  async function init(sk, user) {
    sb = window.Auth.getClient();
    socket = sk;
    currentUser = user;

    // Bind Event Listeners immediately
    if (friendsBtn && !friendsBtn.dataset.bound) {
      friendsBtn.dataset.bound = 'true';
      friendsBtn.addEventListener('click', () => {
        friendsSidebar.classList.toggle('open');
        if (friendsSidebar.classList.contains('open')) loadFriends();
      });
    }
    if (addFriendBtn) {
      addFriendBtn.addEventListener('click', async () => {
        if (currentStrangerId) {
          sendFriendRequest(currentStrangerId);
        } else {
          alert('No active stranger to add.');
        }
      });
    }
    if (closeFriendsBtn) {
      closeFriendsBtn.addEventListener('click', () => {
        friendsSidebar.classList.remove('open');
      });
    }

    friendTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        friendTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        if (tab.dataset.tab === 'list') {
          listView.style.display = 'flex';
          requestsView.style.display = 'none';
        } else {
          listView.style.display = 'none';
          requestsView.style.display = 'flex';
        }
      });
    });

    if (closeMessengerBtn) {
      closeMessengerBtn.addEventListener('click', () => {
        messengerWindow.style.display = 'none';
        openChatFriendId = null;
      });
    }

    if (messengerForm) {
      messengerForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = messengerInput.value.trim();
        if (!text || !openChatFriendId) return;

        messengerInput.value = '';
        renderMessage({ sender_id: currentUser.id, content: text }, true);

        // Send to Supabase
        await sb.from('private_messages').insert({
          sender_id: currentUser.id,
          receiver_id: openChatFriendId,
          content: text
        });

        // Send via Socket for realtime
        socket.emit('private-message', {
          to: openChatFriendId,
          from: currentUser.id,
          content: text,
          timestamp: new Date()
        });
      });
    }

    // Load initial data after binding
    await loadFriends();
  }

  // ── API ─────────────────────────────────────────────────────────────
  
  async function loadFriends() {
    if (!currentUser) return;

    const { data: friendships, error } = await sb
      .from('friendships')
      .select('id, status, requester_id, receiver_id')
      .or(`requester_id.eq.${currentUser.id},receiver_id.eq.${currentUser.id}`);

    if (error) {
      console.error('Error fetching friends:', error);
      return;
    }

    friends = friendships || [];
    const requests = [];
    const accepted = [];

    for (const f of friends) {
      if (f.status === 'accepted') {
        const friendId = f.requester_id === currentUser.id ? f.receiver_id : f.requester_id;
        accepted.push(friendId);
      } else if (f.status === 'pending' && f.receiver_id === currentUser.id) {
        requests.push(f.requester_id);
      }
    }

    const allIds = [...new Set([...requests, ...accepted])];
    if (allIds.length > 0) {
      const { data: profiles } = await sb.from('profiles').select('user_id, profile_picture, nickname').in('user_id', allIds);
      
      const profileMap = {};
      (profiles || []).forEach(p => profileMap[p.user_id] = p);

      renderRequests(requests.map(id => profileMap[id]).filter(Boolean));
      renderFriendsList(accepted.map(id => profileMap[id]).filter(Boolean));
    } else {
      renderRequests([]);
      renderFriendsList([]);
    }

    if (currentStrangerId) setStrangerId(currentStrangerId);
  }

  async function sendFriendRequest(strangerId) {
    if (!strangerId || !currentUser) return;
    
    // Check if exists
    const { data: existing } = await sb.from('friendships')
      .select('id, status')
      .or(`and(requester_id.eq.${currentUser.id},receiver_id.eq.${strangerId}),and(requester_id.eq.${strangerId},receiver_id.eq.${currentUser.id})`);
      
    if (existing && existing.length > 0) {
      alert(existing[0].status === 'accepted' ? 'Already friends!' : 'Request already sent or pending.');
      return;
    }

    const { error } = await sb.from('friendships').insert({
      requester_id: currentUser.id,
      receiver_id: strangerId,
      status: 'pending'
    });

    if (!error) {
      alert('Friend request sent!');
      if (socket) {
        socket.emit('friend-request', { to: strangerId, from: currentUser.id });
      }
      await loadFriends();
    } else {
      console.error(error);
      alert('Error sending friend request');
    }
  }

  async function acceptRequest(friendId) {
    await sb.from('friendships')
      .update({ status: 'accepted' })
      .match({ requester_id: friendId, receiver_id: currentUser.id });
      
    if (socket) {
      socket.emit('friend-accept', { to: friendId, from: currentUser.id });
    }
    loadFriends();
  }

  // ── UI Rendering ────────────────────────────────────────────────────

  function renderRequests(reqs) {
    if (reqs.length > 0) {
      reqBadge.style.display = 'inline-block';
      reqBadge.textContent = reqs.length;
    } else {
      reqBadge.style.display = 'none';
    }

    requestsView.innerHTML = reqs.length ? '' : '<div style="padding:20px;text-align:center;color:var(--text-3)">No pending requests.</div>';
    
    reqs.forEach(p => {
      const item = document.createElement('div');
      item.className = 'friend-item';
      item.innerHTML = `
        <img class="friend-avatar" src="${p.profile_picture || '/images/default-avatar.png'}" alt="Avatar">
        <div class="friend-info">
          <div class="friend-name">${p.nickname || 'User ' + p.user_id.substring(0,6)}</div>
        </div>
        <div class="friend-actions">
          <button class="btn btn-primary" style="padding: 4px 10px; font-size: 11px;">Accept</button>
        </div>
      `;
      item.querySelector('button').addEventListener('click', () => acceptRequest(p.user_id));
      requestsView.appendChild(item);
    });
  }

  function renderFriendsList(friendsList) {
    friends = friendsList;
    listView.innerHTML = friends.length ? '' : '<div style="padding:20px;text-align:center;color:var(--text-3)">Your friends list is empty.</div>';
    
    friendsList.forEach(p => {
      const item = document.createElement('div');
      item.className = 'friend-item';
      item.innerHTML = `
        <img class="friend-avatar" src="${p.profile_picture || '/images/default-avatar.png'}" alt="Avatar">
        <div class="friend-info">
          <div class="friend-name">${p.nickname || 'User ' + p.user_id.substring(0,6)}</div>
          <div class="friend-status"><span class="status-dot"></span> Offline</div>
        </div>
      `;
      item.addEventListener('click', () => openChat(p));
      listView.appendChild(item);
    });
  }

  async function openChat(friend) {
    openChatFriendId = friend.user_id;
    document.getElementById('messenger-name').textContent = friend.nickname || 'User ' + friend.user_id.substring(0,6);
    document.getElementById('messenger-avatar').src = friend.profile_picture || '/images/default-avatar.png';
    messengerWindow.style.display = 'flex';
    messengerMessages.innerHTML = '';

    // Load history
    const { data: msgs } = await sb.from('private_messages')
      .select('*')
      .or(`and(sender_id.eq.${currentUser.id},receiver_id.eq.${friend.user_id}),and(sender_id.eq.${friend.user_id},receiver_id.eq.${currentUser.id})`)
      .order('created_at', { ascending: true })
      .limit(50);
      
    if (msgs) {
      msgs.forEach(m => renderMessage(m, m.sender_id === currentUser.id));
    }
  }

  function renderMessage(msg, isMine) {
    const div = document.createElement('div');
    div.className = 'msg-bubble ' + (isMine ? 'msg-sent' : 'msg-received');
    div.textContent = msg.content;
    messengerMessages.appendChild(div);
    messengerMessages.scrollTop = messengerMessages.scrollHeight;
  }

  // ── Socket Event Handlers ───────────────────────────────────────────

  function handleIncomingSocketEvent(event, data) {
    if (event === 'private-message') {
      if (openChatFriendId === data.from) {
        renderMessage(data, false);
      } else {
        const ping = new Audio('/audio/pop.mp3');
        ping.play().catch(()=>{});
        friendsSidebar.classList.add('open');
        loadFriends();
      }
    } else if (event === 'friend-request') {
      loadFriends(); // Reload to show new request
    } else if (event === 'friend-accept') {
      loadFriends(); // Reload to show new friend
    }
  }

  function setStrangerId(id) {
    currentStrangerId = id;
    if (addFriendBtn) {
      if (!id) {
        addFriendBtn.style.display = 'none';
        return;
      }
      
      addFriendBtn.style.display = 'inline-block';
      const existing = friends.find(f => 
        (f.requester_id === currentUser?.id && f.receiver_id === id) || 
        (f.receiver_id === currentUser?.id && f.requester_id === id)
      );

      const addIcon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="8.5" cy="7" r="4"></circle><line x1="20" y1="8" x2="20" y2="14"></line><line x1="17" y1="11" x2="23" y2="11"></line></svg>`;
      const friendsIcon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="8.5" cy="7" r="4"></circle><polyline points="17 11 19 13 23 9"></polyline></svg>`;
      const pendingIcon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`;

      if (existing) {
        if (existing.status === 'accepted') {
          addFriendBtn.innerHTML = friendsIcon + ' Friends';
          addFriendBtn.disabled = true;
          addFriendBtn.style.opacity = '0.5';
        } else {
          addFriendBtn.innerHTML = pendingIcon + ' Pending';
          addFriendBtn.disabled = true;
          addFriendBtn.style.opacity = '0.5';
        }
      } else {
        addFriendBtn.innerHTML = addIcon + ' Add Friend';
        addFriendBtn.disabled = false;
        addFriendBtn.style.opacity = '1';
      }
    }
  }

    return {
      init,
      sendFriendRequest,
      handleIncomingSocketEvent,
      setStrangerId
    };
  } catch (err) {
    alert('FATAL ERROR IN friends.js: ' + err.message);
    console.error(err);
    return {};
  }
})();

window.Friends = Friends;
