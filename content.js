let currentChannel = null;
let chatWs = null;
let maintenanceInterval = null;
let ccvPollInterval = null;
let cachedChannelData = null;
let isFetchingChannel = false;
let channelActivity = []; // Array to store realtime channel events
let uniqueRawEvents = {}; // Store unique raw JSON events
let processedMsgIds = new Set(); // Prevent duplicate processing of the same message

let excludedKickBots = [
    "kicklet", "kickbot"
];

let combinedExcludedBots = new Set(excludedKickBots);

// Load settings from chrome.storage
function loadSettings() {
    chrome.storage.local.get(['excludedBots'], (result) => {
        if (result.excludedBots) {
            const customBots = new Set(result.excludedBots.map(b => b.toLowerCase()));
            combinedExcludedBots = new Set([...excludedKickBots, ...customBots]);
        }
    });
}

// Listen for changes in storage
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (changes.excludedBots) {
        loadSettings();
    }
});

// Initial load of settings
loadSettings();


// Comprehensive Live Analytics State
let chatAnalytics = {
    chatroomId: null,
    startTime: 0, 
    messageCount: 0,
    totalWordsCount: 0,
    uniqueUsernames: new Set(),
    topUsernames: new Map(),
    totalViewerCount: 0,
    peakViewerCount: 0,
    updateCount: 0,
    currentCCV: 0,
    messageHistory: [], 
    lastTrendRecordTime: Date.now(),
    engagementTrend: [],
    recentMessages: new Map() // Caches up to 1000 recent messages for deletion lookups
};

// Determine if the current URL is a channel page
function getChannelName() {
    const path = window.location.pathname;
    const match = path.match(/^\/([a-zA-Z0-9_]+)$/);
    const excluded = ['categories', 'following', 'dashboard', 'search', 'login', 'signup', 'about'];
    
    if (match && !excluded.includes(match[1].toLowerCase())) {
        return match[1];
    }
    return null;
}

// Inline SVGs (Added help icon)
const icons = {
    search: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`,
    close: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
    check: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#53fc18" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
    x: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
    info: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#a1a1aa" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`,
    activity: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>`,
    help: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`
};

// Helper Formatters
function formatDuration(ms) {
    if (ms < 0) return "0m 0s";
    const totalSeconds = Math.floor(ms / 1000);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    return `${h > 0 ? h + 'h ' : ''}${m}m ${s}s`;
}

function formatNum(n) {
    return n ? n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",") : '0';
}

function formatDate(dateStr) {
    return dateStr ? new Date(dateStr).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'Never';
}

function countWords(message) {
    return message.trim().split(/\s+/).filter(w => w.length > 0).length;
}

// ---------------------------------------------------------------------------------
// ENGAGEMENT LOGIC
// ---------------------------------------------------------------------------------

// Weights sentences heavily, gives very low points to emojis to reflect actual engagement
function getMessageWeight(text) {
    if (!text) return 0.2;
    const cleanText = text.replace(/[^\p{L}\p{N}\s]/gu, '');
    const wordCount = cleanText.trim().split(/\s+/).filter(w => w.length > 1).length;

    if (wordCount === 0) return 0.2; 
    if (wordCount >= 1 && wordCount <= 3) return 1.0; 
    if (wordCount >= 4 && wordCount <= 7) return 2.0; 
    return 3.0; 
}

// Computes the dynamic anti-spam engagement rate
function calculateEngagementRate() {
    if (chatAnalytics.currentCCV <= 0) return 0.0;

    const userMaxWeights = new Map();

    for (const msg of chatAnalytics.messageHistory) {
        const currentMax = userMaxWeights.get(msg.user) || 0;
        if (msg.weight > currentMax) {
            userMaxWeights.set(msg.user, msg.weight);
        }
    }

    let totalScore = 0;
    for (const weight of userMaxWeights.values()) {
        totalScore += weight;
    }

    return (totalScore / chatAnalytics.currentCCV) * 100;
}
// ---------------------------------------------------------------------------------

// Parses and records WebSocket events to the Activity array
function parseActivityEvent(eventName, data) {
    let text = '';
    let color = '#a1a1aa'; // Default grey
    let extraHtml = ''; // Specifically to hold deleted message content
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    if (eventName.includes('UserBannedEvent')) {
        const user = data.user?.username || 'A user';
        const mod = data.banned_by?.username || 'Moderator';
        
        if (data.permanent) {
            text = `${user} was permanently banned by ${mod}`;
        } else {
            const duration = data.duration ? ` for ${data.duration}m` : '';
            text = `${user} was timed out${duration} by ${mod}`;
        }
        color = '#ef4444'; // Red
    } else if (eventName.includes('UserUnbannedEvent')) {
        const user = data.user?.username || 'A user';
        const mod = data.unbanned_by?.username || 'Moderator';
        text = `${user} was unbanned by ${mod}`;
        color = '#53fc18'; // Green
    } else if (eventName.includes('MessageDeletedEvent')) {
        const isAi = data.aiModerated;
        const mod = data.deleted_by?.username || (isAi ? 'AutoMod (AI)' : 'Moderator');
        const msgId = data.message?.id;

        // Try to fetch the cached message using the ID
        let cachedMsg = null;
        if (msgId && chatAnalytics.recentMessages && chatAnalytics.recentMessages.has(msgId)) {
            cachedMsg = chatAnalytics.recentMessages.get(msgId);
        }
        
        // Try to get username from payload (if human mod), fallback to cache (if AutoMod)
        let username = data.message?.sender?.username;
        if (!username && cachedMsg) {
            username = cachedMsg.sender;
        }
        const userText = username ? ` from ${username}` : '';
        
        let rules = '';
        if (data.violatedRules && data.violatedRules.length > 0) {
            const formattedRules = data.violatedRules.map(r => r.replace(/_/g, ' ')).join(', ');
            rules = ` [Reason: ${formattedRules}]`;
        }
        
        text = `Message${userText} was deleted by ${mod}${rules}`;
        color = '#f59e0b'; // Orange

        // Attempt to retrieve the deleted message content from our cache
        if (cachedMsg) {
            extraHtml = `<div style="margin-top:6px; font-style:italic; color:#d4d4d8; padding:6px 10px; background:rgba(0,0,0,0.2); border-radius:4px; border-left:2px solid ${color}; word-break: break-word;">"${cachedMsg.content}"</div>`;
        } else if (data.message?.content) {
            extraHtml = `<div style="margin-top:6px; font-style:italic; color:#d4d4d8; padding:6px 10px; background:rgba(0,0,0,0.2); border-radius:4px; border-left:2px solid ${color}; word-break: break-word;">"${data.message.content}"</div>`;
        } else {
            extraHtml = `<div style="margin-top:6px; font-style:italic; color:#71717a; padding:6px 10px; background:rgba(0,0,0,0.2); border-radius:4px; border-left:2px solid ${color};"><em>[Message content unavailable (sent before you joined)]</em></div>`;
        }
    } else if (eventName === 'App\\Events\\SubscriptionEvent') {
        const user = data.username || 'Someone';
        const months = data.months ? ` (Month ${data.months})` : '';
        text = `${user} subscribed!${months}`;
        color = '#53fc18'; 
    } else if (eventName.includes('LuckyUsersWhoGotGiftSubscriptionsEvent') || eventName.includes('GiftedSubscriptionsEvent')) {
        const gifter = data.gifter_username || 'Someone';
        const amount = data.usernames?.length || data.gifted_usernames?.length || 'some';
        text = `${gifter} gifted ${amount} subs!`;
        color = '#53fc18';
    } else if (eventName.includes('ChatroomUpdatedEvent') || eventName.includes('SlowMode') || eventName.includes('FollowersMode')) {
        text = `Chatroom settings (Slowmode/Followers-only) were updated`;
        color = '#3b82f6'; // Blue
    } else if (eventName.includes('StreamTitleUpdatedEvent') || eventName.includes('StreamTitleEvent')) {
        text = `Stream title was updated`;
        color = '#3b82f6'; 
    } else if (eventName.includes('FollowersUpdatedEvent') || eventName.includes('NewFollowerEvent')) {
        const user = data.username || data.follower?.username;
        if (user) {
            text = `${user} just followed!`;
            color = '#3b82f6';
        }
    }

    if (text) {
        channelActivity.unshift({ time, text, color, extraHtml });
        if (channelActivity.length > 200) channelActivity.pop(); // Keep log manageable
        updateActivityTabIfOpen();
    }
}

// Connect to Kick's Pusher WebSocket
function connectPusher(chatroomId, initialCCV, channelId) {
    if (chatWs) return; // Already connected
    
    // Only reset analytics if entering a completely new chatroom
    if (chatAnalytics.chatroomId !== chatroomId) {
        chatAnalytics = {
            chatroomId: chatroomId,
            startTime: Date.now(),
            messageCount: 0,
            totalWordsCount: 0,
            uniqueUsernames: new Set(),
            topUsernames: new Map(),
            totalViewerCount: initialCCV > 0 ? initialCCV : 0,
            peakViewerCount: initialCCV,
            updateCount: initialCCV > 0 ? 1 : 0,
            currentCCV: initialCCV,
            messageHistory: [],
            lastTrendRecordTime: Date.now(),
            engagementTrend: [],
            recentMessages: new Map()
        };
        processedMsgIds.clear();
    }

    const pusherKey = '32cbd69e4b950bf97679'; 
    chatWs = new WebSocket(`wss://ws-us2.pusher.com/app/${pusherKey}?protocol=7&client=js&version=7.6.0&flash=false`);
    
    chatWs.onopen = () => {
        // Subscribe to chat events
        chatWs.send(JSON.stringify({
            event: "pusher:subscribe",
            data: { auth: "", channel: `chatrooms.${chatroomId}.v2` }
        }));
        
        // Subscribe to overall channel events (Title changes, followers, etc.)
        if (channelId) {
            chatWs.send(JSON.stringify({
                event: "pusher:subscribe",
                data: { auth: "", channel: `channel.${channelId}` }
            }));
        }
    };

    chatWs.onclose = () => { chatWs = null; };
    chatWs.onerror = () => { chatWs = null; };
    
    chatWs.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            
            let innerData = null;
            if (data.data) {
                innerData = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
            }

            // Save unique raw events for the Raw JSON debug tab (exclude internal pusher pings)
            if (data.event && !data.event.includes("pusher:ping") && !data.event.includes("pusher:pong") && !uniqueRawEvents[data.event]) {
                uniqueRawEvents[data.event] = { event: data.event, data: innerData };
                updateRawTabIfOpen();
            }

            if (data.event === "pusher:ping") {
                chatWs.send(JSON.stringify({ event: "pusher:pong" }));
            } else if (data.event && data.event.includes("ChatMessageEvent")) {
                const msgId = innerData.id;
                
                // Duplicate Protection: Skip if we've already seen this specific message ID
                if (msgId && processedMsgIds.has(msgId)) return;
                if (msgId) {
                    processedMsgIds.add(msgId);
                    if (processedMsgIds.size > 2000) {
                         const first = processedMsgIds.values().next().value;
                         processedMsgIds.delete(first);
                    }
                }

                const username = innerData.sender?.username || 'unknown';
                const lowerUsername = username.toLowerCase();
                
                // Exclude Bots
                if (combinedExcludedBots.has(lowerUsername)) return;

                const content = innerData.content || '';
                const words = countWords(content);
                const msgWeight = getMessageWeight(content); // Apply new weighted engagement score!

                // Store recent messages (both text AND sender) for deleted message lookups
                if (msgId) {
                    chatAnalytics.recentMessages.set(msgId, { content: content, sender: username });
                    if (chatAnalytics.recentMessages.size > 1000) {
                        const firstKey = chatAnalytics.recentMessages.keys().next().value;
                        chatAnalytics.recentMessages.delete(firstKey);
                    }
                }
                
                // Update metrics
                chatAnalytics.messageCount++;
                chatAnalytics.totalWordsCount += words;
                chatAnalytics.uniqueUsernames.add(lowerUsername);
                chatAnalytics.topUsernames.set(username, (chatAnalytics.topUsernames.get(username) || 0) + 1);
                
                // Push standard ts + user + our new Weight Multiplier!
                chatAnalytics.messageHistory.push({ ts: Date.now(), user: lowerUsername, weight: msgWeight });
                updateAnalyticsUI();
            } else if (data.event && !data.event.includes("pusher:")) {
                // Pass all other events to the Activity Tracker
                parseActivityEvent(data.event, innerData);
            }
        } catch(e) {
            console.error("Kick Inspector: Error parsing pusher message", e);
        }
    };

    // Maintenance Interval 
    if (maintenanceInterval) clearInterval(maintenanceInterval);
    maintenanceInterval = setInterval(() => {
        const now = Date.now();
        chatAnalytics.messageHistory = chatAnalytics.messageHistory.filter(m => now - m.ts < 180000); 

        // Record the 3-minute trend snapshot
        if (now - chatAnalytics.lastTrendRecordTime >= 180000) {
            const pct = calculateEngagementRate().toFixed(1);
            const timeLabel = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            
            chatAnalytics.engagementTrend.push({ time: timeLabel, pct: pct });
            if (chatAnalytics.engagementTrend.length > 8) {
                chatAnalytics.engagementTrend.shift(); 
            }
            chatAnalytics.lastTrendRecordTime = now;
        }

        updateAnalyticsUI();
        updateAnalyticsModalIfOpen(); 
    }, 1000);
}

function updateAnalyticsUI() {
    const badgeText = document.getElementById('ki-eng-text');
    if (badgeText) {
        badgeText.innerText = `${calculateEngagementRate().toFixed(1)}%`;
    }
}

function disconnectPusher() {
    if (chatWs) {
        chatWs.close();
        chatWs = null;
    }
    if (maintenanceInterval) clearInterval(maintenanceInterval);
}

// Inject the button INLINE next to Follow/Subscribe
function injectInlineUI(channelData) {
    const channel = getChannelName();
    if (!channel) return;

    const oldBtn = document.getElementById('ki-inline-btn');
    if (oldBtn) oldBtn.remove();
    if (document.getElementById('ki-inline-wrapper')) return;

    const mainArea = document.querySelector('main') || document.body;
    const allButtons = Array.from(mainArea.querySelectorAll('button'));

    let actionBtn = allButtons.find(btn => {
        const text = btn.textContent.trim().toLowerCase();
        return text === 'subscribe' || text === 'gift subs' || text === 'follow' || text === 'following';
    });

    if (actionBtn) {
        const wrapper = document.createElement('div');
        wrapper.id = 'ki-inline-wrapper';
        wrapper.style.display = 'flex';
        wrapper.style.alignItems = 'center';

        // Chat Engagement Badge 
        const badge = document.createElement('div');
        badge.className = 'ki-engagement-badge ki-clickable-badge';
        badge.innerHTML = `${icons.activity} <span id="ki-eng-text">0.0%</span>`;
        badge.title = "Chat Engagement Rate (Click for Analytics)";
        badge.onclick = () => openAnalyticsModal(channelData);
        wrapper.appendChild(badge);
        
        // Inspect Button (Icon only)
        const btn = document.createElement('button');
        btn.className = 'ki-inline-btn-style';
        btn.innerHTML = `${icons.search}`;
        btn.title = "Inspect Profile & Activity";
        btn.onclick = () => openModal(channelData);

        wrapper.appendChild(btn);

        // Find the overarching button container
        let targetContainer = actionBtn.parentElement;
        
        // Kick groups buttons in a flex container. If the immediate parent is a tight wrapper (only 1 child),
        // and its parent is the flex row, move up to the flex row.
        if (targetContainer && targetContainer.children.length === 1 && targetContainer.parentElement) {
            if (targetContainer.parentElement.className?.includes('flex')) {
                targetContainer = targetContainer.parentElement;
            }
        }

        if (targetContainer) {
            // Force horizontal alignment to fix stacking on unverified channels
            targetContainer.style.display = 'flex';
            targetContainer.style.alignItems = 'center';
            
            // Insert at the VERY FRONT of the container (left of Bell/Heart, or left of Follow)
            targetContainer.insertBefore(wrapper, targetContainer.firstChild);
        }
    }
}

// Generate the Main Profile Inspector Modal
function openModal(channelData) {
    const existing = document.getElementById('kick-inspector-root');
    if (existing) existing.remove();

    const root = document.createElement('div');
    root.id = 'kick-inspector-root';
    
    root.innerHTML = `
        <div class="ki-modal-overlay">
            <div class="ki-modal">
                <div class="ki-modal-header" style="border-bottom: none; padding-bottom: 0;">
                    <h2 style="margin:0; padding-bottom: 16px; font-size:16px; font-weight:700; display:flex; align-items:center; gap:8px;">
                        ${icons.search} Inspecting <span style="color:#53fc18">@${channelData.slug}</span>
                    </h2>
                    <button class="ki-modal-close" id="ki-close-btn" style="margin-bottom: 16px;">${icons.close}</button>
                </div>
                
                <div class="ki-modal-tabs">
                    <button class="ki-tab active" id="tab-btn-profile">Profile</button>
                    <button class="ki-tab" id="tab-btn-activity">Activity</button>
                    <button class="ki-tab" id="tab-btn-raw">Raw JSON</button>
                </div>

                <div class="ki-modal-content" id="ki-content">
                    <div id="ki-profile-tab" class="ki-tab-content active">
                        <div class="ki-loader"></div>
                        <div style="text-align:center; color:#a1a1aa; font-size:14px;">Loading...</div>
                    </div>
                    <div id="ki-activity-tab" class="ki-tab-content">
                        <!-- Activity populated dynamically -->
                    </div>
                    <div id="ki-raw-tab" class="ki-tab-content">
                        <!-- Raw JSON populated dynamically -->
                    </div>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(root);

    // Close logic
    document.getElementById('ki-close-btn').onclick = () => root.remove();
    root.querySelector('.ki-modal-overlay').addEventListener('click', (e) => {
        if(e.target === e.currentTarget) root.remove();
    });

    // Tab Switching Helper
    const switchTab = (tabId) => {
        ['profile', 'activity', 'raw'].forEach(t => {
            document.getElementById(`tab-btn-${t}`).classList.remove('active');
            document.getElementById(`ki-${t}-tab`).classList.remove('active');
        });
        document.getElementById(`tab-btn-${tabId}`).classList.add('active');
        document.getElementById(`ki-${tabId}-tab`).classList.add('active');
    };

    // Tab Switching Logic
    document.getElementById('tab-btn-profile').onclick = () => switchTab('profile');
    
    document.getElementById('tab-btn-activity').onclick = () => {
        switchTab('activity');
        updateActivityTabIfOpen();
    };

    document.getElementById('tab-btn-raw').onclick = () => {
        switchTab('raw');
        updateRawTabIfOpen();
    };

    renderData(channelData);
    updateActivityTabIfOpen();
    updateRawTabIfOpen();
}

// Renders the real-time activity log into the Activity tab
function updateActivityTabIfOpen() {
    const activityTab = document.getElementById('ki-activity-tab');
    if (!activityTab) return;

    let html = `
        <div style="background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.2); border-radius: 8px; padding: 12px; margin-bottom: 16px; display: flex; gap: 8px; align-items: flex-start;">
            <div style="margin-top:2px;">${icons.info}</div>
            <div style="font-size: 13px; color: #a1a1aa; line-height: 1.5;">
                <strong style="color: #3b82f6;">Note:</strong> Activity is only tracked while you are actively watching this stream. Events that happened before you arrived cannot be retrieved.
            </div>
        </div>
    `;

    if (channelActivity.length === 0) {
        html += `<div style="text-align:center; color:#71717a; padding: 30px 0; font-size: 14px;">No recent activity detected yet...</div>`;
    } else {
        html += `<div style="display:flex; flex-direction:column; gap:8px;">`;
        for (const item of channelActivity) {
            html += `
                <div style="display:flex; gap:12px; background:#1a1d22; padding:12px; border-radius:6px; border-left: 3px solid ${item.color};">
                    <span style="color:#71717a; font-size:12px; white-space:nowrap;">${item.time}</span>
                    <div style="display:flex; flex-direction:column; width: 100%;">
                        <span style="color:#ffffff; font-size:13px; font-weight:500;">${item.text}</span>
                        ${item.extraHtml || ''}
                    </div>
                </div>
            `;
        }
        html += `</div>`;
    }

    activityTab.innerHTML = html;
}

// Renders the unique raw JSON events into the Raw tab
function updateRawTabIfOpen() {
    const rawTab = document.getElementById('ki-raw-tab');
    if (!rawTab) return;

    if (Object.keys(uniqueRawEvents).length === 0) {
        rawTab.innerHTML = `<div style="text-align:center; color:#71717a; padding: 30px 0; font-size: 14px;">Listening for new events...</div>`;
        return;
    }

    let html = `
        <div style="background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.2); border-radius: 8px; padding: 12px; margin-bottom: 16px; display: flex; gap: 8px; align-items: flex-start;">
            <div style="margin-top:2px;">${icons.info}</div>
            <div style="font-size: 13px; color: #a1a1aa; line-height: 1.5;">
                <strong style="color: #3b82f6;">Debug Mode:</strong> Displaying raw JSON payloads. Only the first instance of each event type is saved.
            </div>
        </div>
        <div style="display:flex; flex-direction:column; gap:12px;">
    `;
    
    for (const [eventName, eventData] of Object.entries(uniqueRawEvents)) {
        html += `
            <div style="background:#1a1d22; padding:12px; border-radius:6px; border: 1px solid #24272c;">
                <h4 style="margin:0 0 8px 0; color:#53fc18; font-size:14px; font-family:monospace;">${eventName}</h4>
                <pre style="margin:0; font-size:11px; color:#a1a1aa; overflow-x:auto; white-space:pre-wrap; word-wrap:break-word; font-family:monospace;">${JSON.stringify(eventData.data, null, 2)}</pre>
            </div>
        `;
    }
    html += `</div>`;
    rawTab.innerHTML = html;
}

// Helper to create stat cards with tooltips
function createCard(label, value, tooltipText, valueClass = "", customStyle = "") {
    return `
        <div class="ki-card" style="${customStyle}">
            <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom: 6px;">
                <span class="ki-label" style="margin-bottom:0;">${label}</span>
                <div class="ki-help-icon">
                    ${icons.help}
                    <div class="ki-tooltip-text">${tooltipText}</div>
                </div>
            </div>
            <span class="ki-value ${valueClass}">${value}</span>
        </div>
    `;
}

// Generate the Live Analytics Modal
function openAnalyticsModal(channelData) {
    const existing = document.getElementById('kick-inspector-root');
    if (existing) existing.remove();

    const root = document.createElement('div');
    root.id = 'kick-inspector-root';
    root.innerHTML = `
        <div class="ki-modal-overlay">
            <div class="ki-modal" style="max-width: 800px;">
                <div class="ki-modal-header">
                    <h2 style="margin:0; font-size:16px; font-weight:700; display:flex; align-items:center; gap:8px;">
                        ${icons.activity} Live Analytics: <span style="color:#53fc18">@${channelData.slug}</span>
                    </h2>
                    <button class="ki-modal-close" id="ki-close-btn">${icons.close}</button>
                </div>
                <div class="ki-modal-content" id="ki-analytics-content">
                    <!-- Dynamic content injected here -->
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(root);
    
    document.getElementById('ki-close-btn').onclick = () => root.remove();
    root.querySelector('.ki-modal-overlay').addEventListener('click', (e) => {
        if(e.target === e.currentTarget) root.remove();
    });

    updateAnalyticsModalIfOpen();
}

// Update the dynamic stats in the Analytics Modal
function updateAnalyticsModalIfOpen() {
    const container = document.getElementById('ki-analytics-content');
    if (!container) return;

    // Time calculations
    const now = Date.now();
    const elapsedMs = now - chatAnalytics.startTime;
    const elapsedSeconds = Math.max(elapsedMs / 1000, 1); 
    const elapsedMinutes = Math.max(elapsedSeconds / 60, 0.01);
    const elapsedHours = Math.max(elapsedMinutes / 60, 0.0001);
    const watchStr = formatDuration(elapsedMs);
    
    // Viewer metrics
    const ccv = chatAnalytics.currentCCV;
    const peak = chatAnalytics.peakCCV;
    const avg = chatAnalytics.updateCount > 0 
        ? Math.round(chatAnalytics.totalViewerCount / chatAnalytics.updateCount) 
        : 0;

    // Chat metrics
    const totalMsgs = chatAnalytics.messageCount;
    const uniqueAllTime = chatAnalytics.uniqueUsernames.size;
    
    let twoOrLessCount = 0;
    let sortedChatters = [];
    for (let [user, count] of chatAnalytics.topUsernames.entries()) {
        if (count <= 2) twoOrLessCount++;
        sortedChatters.push({user, count});
    }
    
    sortedChatters.sort((a,b) => b.count - a.count);
    const top5 = sortedChatters.slice(0, 5);

    // Rate calculations
    const wpm = chatAnalytics.totalWordsCount / elapsedMinutes;
    const mpm = totalMsgs / elapsedMinutes;
    const mph = totalMsgs / elapsedHours;
    
    // Engagement Numbers
    const sessionEngPct = avg > 0 ? (uniqueAllTime / avg) * 100 : 0;
    const engPct = calculateEngagementRate();
    
    // Gauge calculations
    const gaugeFill = Math.min(engPct / 40, 1); 
    const dashArray = 125.6; 
    const dashOffset = dashArray - (dashArray * gaugeFill);
    
    let gaugeColor = "#3b82f6"; // Blue (Cold)
    if (engPct > 3.0) gaugeColor = "#f59e0b"; // Orange (Warm)
    if (engPct > 10.0) gaugeColor = "#ef4444"; // Red (Hot)
    if (engPct > 20.0) gaugeColor = "#53fc18"; // Kick Green (Extreme Hype)

    const getTrendColor = (pct) => {
        if (pct > 20.0) return "#53fc18";
        if (pct > 10.0) return "#ef4444";
        if (pct > 3.0) return "#f59e0b";
        return "#3b82f6";
    };

    container.innerHTML = `
        <!-- Top Stats Row -->
        <div class="ki-grid">
            ${createCard("Session Duration", watchStr, "Total time elapsed since you joined and began tracking this stream.")}
            ${createCard("Live Viewers (CCV)", formatNum(ccv), "Current number of concurrent live viewers watching the stream.", "green")}
            ${createCard("Peak Viewers", formatNum(peak), "Highest number of concurrent viewers recorded during your tracking session.")}
            ${createCard("Average Viewers", formatNum(avg), "Average viewer count across your entire tracking session.")}
            
            ${createCard("Total Messages", formatNum(totalMsgs), "Total number of chat messages sent by actual users (excluding known bots).")}
            ${createCard("Unique Chatters", formatNum(uniqueAllTime), "Total number of distinct users who have sent at least one message.")}
            ${createCard("Words / Min (WPM)", formatNum(Math.round(wpm)), "Average number of actual words (excluding emojis/symbols) sent in chat per minute.")}
            ${createCard("Messages / Min (MPM)", formatNum(Math.round(mpm)), "Average number of individual messages sent per minute.")}
        </div>

        <!-- Highlighted Engagement Comparison Row -->
        <h3 style="margin: 8px 0 0 0; font-size:12px; color:#a1a1aa; text-transform:uppercase; letter-spacing:0.05em; display:flex; justify-content:space-between;">
            Engagement Comparison
        </h3>
        <div class="ki-grid">
            ${createCard(
                "Session Eng. (Raw Headcount)", 
                `${sessionEngPct.toFixed(1)}%`, 
                "All-Time Unique Chatters divided by Average Viewers. This gives exactly 1 point per person who chats, regardless of what they say.", 
                "", 
                "background: rgba(83, 252, 24, 0.05); border-color: rgba(83, 252, 24, 0.2);"
            )}
            ${createCard(
                "3-Min Eng. (Quality-Weighted)", 
                `${engPct.toFixed(1)}%`, 
                "Real-time Anti-Spam Score over the last 3 minutes. Evaluates chat effort: Sentences reward more points, emoji spam rewards less. Strongly prevents manipulation.", 
                "", 
                "background: rgba(59, 130, 246, 0.05); border-color: rgba(59, 130, 246, 0.2);"
            )}
        </div>

        <!-- Bottom Detail Panels -->
        <div style="display:flex; gap: 16px; margin-top: 8px;">
            <div class="ki-card" style="flex:1; display:flex; flex-direction:column; align-items:center;">
                <div style="width:100%; display:flex; justify-content:space-between;">
                    <span class="ki-label">3M Quality Speedometer</span>
                    <div class="ki-help-icon">
                        ${icons.help}
                        <div class="ki-tooltip-text">Visual representation of the Quality-Weighted Engagement score. Maxes out visually at 40%.</div>
                    </div>
                </div>
                <div style="position:relative; width: 120px; height: 60px; margin-top: 10px;">
                    <svg viewBox="0 0 100 50" style="width: 100%; height: 100%; overflow: visible;">
                        <path d="M 10 50 A 40 40 0 0 1 90 50" fill="none" stroke="#24272c" stroke-width="12" stroke-linecap="round"/>
                        <path d="M 10 50 A 40 40 0 0 1 90 50" fill="none" stroke="${gaugeColor}" stroke-width="12" stroke-linecap="round" stroke-dasharray="${dashArray}" stroke-dashoffset="${dashOffset}" style="transition: stroke-dashoffset 1s ease, stroke 1s ease;" />
                    </svg>
                    <div style="position:absolute; bottom: -5px; width: 100%; text-align:center; font-size: 18px; font-weight: 700;">
                        ${engPct.toFixed(1)}%
                    </div>
                </div>
            </div>

            <div class="ki-card" style="flex:1;">
                <div style="width:100%; display:flex; justify-content:space-between;">
                    <span class="ki-label">3-Min Trend History</span>
                    <div class="ki-help-icon">
                        ${icons.help}
                        <div class="ki-tooltip-text">Historical log of the Quality-Weighted Engagement score over time. Updates every 3 minutes.</div>
                    </div>
                </div>
                <div style="display:flex; flex-direction:column; gap: 4px; margin-top: 8px;">
                    ${chatAnalytics.engagementTrend.length > 0 ? [...chatAnalytics.engagementTrend].reverse().map(t => `
                        <div style="display:flex; justify-content:space-between; font-size: 13px;">
                            <span style="color:#a1a1aa;">${t.time}</span>
                            <span style="font-weight:600; color:${getTrendColor(parseFloat(t.pct))};">${t.pct}%</span>
                        </div>
                    `).join('') : '<span style="color:#71717a; font-size:12px; text-align:center; margin-top:8px;">Waiting for 3m mark...</span>'}
                </div>
            </div>

            <div class="ki-card" style="flex:1;">
                <div style="width:100%; display:flex; justify-content:space-between;">
                    <span class="ki-label">Top Chatters</span>
                    <div class="ki-help-icon">
                        ${icons.help}
                        <div class="ki-tooltip-text">Users who have sent the most messages this session. Total session "Drive-By" users (≤ 2 msgs): ${twoOrLessCount}</div>
                    </div>
                </div>
                <div style="display:flex; flex-direction:column; gap: 4px; margin-top: 8px;">
                    ${top5.length > 0 ? top5.map((c, i) => `
                        <div style="display:flex; justify-content:space-between; font-size: 13px;">
                            <span style="color:#a1a1aa; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:90px;">${i+1}. ${c.user}</span>
                            <span style="font-weight:600; color:#53fc18;">${formatNum(c.count)}</span>
                        </div>
                    `).join('') : '<span style="color:#71717a; font-size:12px; text-align:center; margin-top:8px;">No chatters yet</span>'}
                </div>
            </div>
        </div>
    `;
}

// Populate the Profile Tab
function renderData(data) {
    const user = data.user || {};
    const cr = data.chatroom || {};
    const boolIcon = (val) => val ? icons.check : icons.x;

    const html = `
        <div style="display:flex; gap:16px; align-items:center; background:#14171c; padding:16px; border-radius:8px; border:1px solid #24272c;">
            <img src="${user.profile_pic || ''}" style="width:64px; height:64px; border-radius:50%; background:#24272c; object-fit:cover;" onerror="this.style.display='none'">
            <div>
                <h1 style="margin:0 0 4px 0; font-size:20px; display:flex; align-items:center; gap:6px;">
                    ${user.username || data.slug}
                    ${data.verified ? `<span style="color:#53fc18" title="Verified">${icons.check}</span>` : ''}
                </h1>
                <div style="color:#a1a1aa; font-size:13px; line-height:1.5; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;">
                    ${user.bio || 'No bio provided.'}
                </div>
            </div>
        </div>

        <div class="ki-grid" style="margin-top: 16px;">
            <div class="ki-card">
                <span class="ki-label">Followers</span>
                <span class="ki-value green">${formatNum(data.followers_count || data.followersCount)}</span>
            </div>
            <div class="ki-card">
                <span class="ki-label">Account Status</span>
                <span class="ki-value ${data.is_banned ? 'red' : 'green'}">${data.is_banned ? 'Banned' : 'Active'}</span>
            </div>
        </div>

        <h3 style="margin: 16px 0 0 0; font-size:13px; color:#ffffff; display:flex; align-items:center; gap:6px;">
            ${icons.info} Features & Permissions
        </h3>
        <div class="ki-grid">
            <div class="ki-card" style="display:flex; justify-content:space-between; align-items:center; padding:12px 14px;">
                <span class="ki-label" style="margin:0;">Subs Enabled</span>
                ${boolIcon(data.subscription_enabled)}
            </div>
            <div class="ki-card" style="display:flex; justify-content:space-between; align-items:center; padding:12px 14px;">
                <span class="ki-label" style="margin:0;">VODs Saved</span>
                ${boolIcon(data.vod_enabled)}
            </div>
            <div class="ki-card" style="display:flex; justify-content:space-between; align-items:center; padding:12px 14px;">
                <span class="ki-label" style="margin:0;">Can Host</span>
                ${boolIcon(data.can_host)}
            </div>
            <div class="ki-card" style="display:flex; justify-content:space-between; align-items:center; padding:12px 14px;">
                <span class="ki-label" style="margin:0;">Muted</span>
                ${boolIcon(data.muted)}
            </div>
        </div>

        <h3 style="margin: 16px 0 0 0; font-size:13px; color:#ffffff; display:flex; align-items:center; gap:6px;">
            ${icons.info} Chatroom Rules
        </h3>
        <div class="ki-grid">
            <div class="ki-card">
                <span class="ki-label">Slow Mode</span>
                <span class="ki-value" style="font-size:14px; font-weight:500;">
                    ${cr.slow_mode?.enabled ?? cr.slow_mode ? `<span style="color:#53fc18">On</span> (${cr.message_interval}s)` : 'Off'}
                </span>
            </div>
            <div class="ki-card">
                <span class="ki-label">Followers Only</span>
                <span class="ki-value" style="font-size:14px; font-weight:500;">
                    ${cr.followers_mode?.enabled ?? cr.followers_mode ? `<span style="color:#53fc18">On</span> (${cr.following_min_duration}m)` : 'Off'}
                </span>
            </div>
            <div class="ki-card">
                <span class="ki-label">Subscribers Only</span>
                <span class="ki-value" style="font-size:14px; font-weight:500;">
                    ${cr.subscribers_mode?.enabled ?? cr.subscribers_mode ? '<span style="color:#53fc18">On</span>' : 'Off'}
                </span>
            </div>
            <div class="ki-card">
                <span class="ki-label">Emotes Only</span>
                <span class="ki-value" style="font-size:14px; font-weight:500;">
                    ${cr.emotes_mode?.enabled ?? cr.emotes_mode ? '<span style="color:#53fc18">On</span>' : 'Off'}
                </span>
            </div>
        </div>
        
        <h3 style="margin: 16px 0 0 0; font-size:13px; color:#ffffff; display:flex; align-items:center; gap:6px;">
            ${icons.info} API & Meta Data
        </h3>
        <div class="ki-grid">
            <div class="ki-card">
                <span class="ki-label">Channel ID</span>
                <span class="ki-value" style="font-size:13px; font-family:monospace; color:#a1a1aa;">${data.id || 'N/A'}</span>
            </div>
            <div class="ki-card">
                <span class="ki-label">User ID</span>
                <span class="ki-value" style="font-size:13px; font-family:monospace; color:#a1a1aa;">${data.user_id || user.id || 'N/A'}</span>
            </div>
            <div class="ki-card">
                <span class="ki-label">Chatroom ID</span>
                <span class="ki-value" style="font-size:13px; font-family:monospace; color:#a1a1aa;">${cr.id || 'N/A'}</span>
            </div>
            <div class="ki-card">
                <span class="ki-label">Agreed to Terms</span>
                <span class="ki-value" style="font-size:14px; font-weight:500;">
                    ${user.agreed_to_terms ? '<span style="color:#53fc18">Yes</span>' : '<span style="color:#ef4444">No</span>'}
                </span>
            </div>
            <div class="ki-card">
                <span class="ki-label">Email Verified</span>
                <span class="ki-value" style="font-size:13px; color:#a1a1aa;">${user.email_verified_at ? formatDate(user.email_verified_at) : 'No'}</span>
            </div>
            <div class="ki-card">
                <span class="ki-label">Name Updated</span>
                <span class="ki-value" style="font-size:13px; color:#a1a1aa;">${formatDate(data.name_updated_at)}</span>
            </div>
        </div>
    `;
    
    // Inject into the Profile Tab specifically
    const profileTab = document.getElementById('ki-profile-tab');
    if (profileTab) profileTab.innerHTML = html;
}

// Background poller & initialization
async function handleDomMutation() {
    const channel = getChannelName();
    
    // Left the channel entirely
    if (!channel) {
        currentChannel = null;
        cachedChannelData = null;
        channelActivity = []; // Clear log
        uniqueRawEvents = {}; // Clear raw events
        disconnectPusher();
        if (ccvPollInterval) clearInterval(ccvPollInterval);
        const wrapper = document.getElementById('ki-inline-wrapper');
        if (wrapper) wrapper.remove();
        const modal = document.getElementById('kick-inspector-root');
        if (modal) modal.remove();
        return;
    }

    // Switched to a new channel
    if (channel !== currentChannel) {
        currentChannel = channel;
        cachedChannelData = null;
        channelActivity = []; // Clear log for new channel
        uniqueRawEvents = {}; // Clear raw events
        disconnectPusher();
        if (ccvPollInterval) clearInterval(ccvPollInterval);
        const wrapper = document.getElementById('ki-inline-wrapper');
        if (wrapper) wrapper.remove();
    }

    if (!cachedChannelData && !isFetchingChannel) {
        isFetchingChannel = true;
        try {
            const res = await fetch(`https://kick.com/api/v1/channels/${channel}`);
            if (res.ok) {
                cachedChannelData = await res.json();
                
                // Fetch CCV periodically to build Average/Peak and toggle Live state
                if (ccvPollInterval) clearInterval(ccvPollInterval);
                ccvPollInterval = setInterval(async () => {
                    try {
                        const r = await fetch(`https://kick.com/api/v1/channels/${channel}`);
                        if (r.ok) {
                            const d = await r.json();
                            
                            cachedChannelData.livestream = d.livestream; 
                            injectInlineUI(cachedChannelData);

                            const ccv = d.livestream?.viewer_count || 0;
                            
                            if (ccv > 0) {
                                chatAnalytics.currentCCV = ccv;
                                chatAnalytics.totalViewerCount += ccv;
                                chatAnalytics.updateCount++;
                                if (ccv > chatAnalytics.peakViewerCount) {
                                    chatAnalytics.peakViewerCount = ccv;
                                }
                            }

                            if (d.livestream && d.chatroom) {
                                // Added channel id to connection payload for full event tracking
                                if (!chatWs) connectPusher(d.chatroom.id, ccv, d.id);
                            } else {
                                if (chatWs) disconnectPusher();
                            }

                            updateAnalyticsUI();
                            updateAnalyticsModalIfOpen();
                        }
                    } catch(e) {}
                }, 3000); 

                if (cachedChannelData.chatroom && cachedChannelData.livestream) {
                    const initialCCV = cachedChannelData.livestream?.viewer_count || 0;
                    connectPusher(cachedChannelData.chatroom.id, initialCCV, cachedChannelData.id);
                }
            }
        } catch (err) {
            console.error("Kick Inspector: Failed to fetch channel data", err);
        } finally {
            isFetchingChannel = false;
        }
    }

    if (cachedChannelData) {
        injectInlineUI(cachedChannelData);
        
        if (!chatWs && cachedChannelData.chatroom && cachedChannelData.livestream) {
            connectPusher(cachedChannelData.chatroom.id, chatAnalytics.currentCCV || 0, cachedChannelData.id);
        }
    }
}

// Watch Kick's DOM for changes
const observer = new MutationObserver(() => {
    handleDomMutation();
});

observer.observe(document.body, { subtree: true, childList: true });
setTimeout(handleDomMutation, 1000);