require('dotenv').config();
const { Telegraf, Markup, session } = require('telegraf');
const admin = require('firebase-admin');

// Initialize Firebase
const serviceAccount = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
};

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();
const bot = new Telegraf(process.env.BOT_TOKEN);

// Global variables (will be reset on restart, but we'll use Firestore as source of truth)
let confessionCounter = 0; // This will be updated from Firestore

// Initialize confession counter from Firestore (source of truth)
async function initializeCounter() {
  try {
    // Get the system counters document
    const counterDoc = await db.collection('system').doc('counters').get();
    
    if (!counterDoc.exists) {
      // Initialize if doesn't exist
      const snapshot = await db.collection('confessions')
        .where('status', '==', 'approved')
        .orderBy('confessionNumber', 'desc')
        .limit(1)
        .get();
      
      let maxConfession = 0;
      if (!snapshot.empty) {
        maxConfession = snapshot.docs[0].data().confessionNumber || 0;
      }
      
      // Set initial counter
      await db.collection('system').doc('counters').set({
        confessionNumber: maxConfession,
        lastAssigned: new Date().toISOString(),
        initialized: new Date().toISOString()
      });
      
      confessionCounter = maxConfession;
      console.log(`Initialized confession counter: ${confessionCounter}`);
    } else {
      const data = counterDoc.data();
      confessionCounter = data.confessionNumber || 0;
      console.log(`Loaded confession counter from Firestore: ${confessionCounter}`);
    }
  } catch (error) {
    console.error('Counter init error:', error);
    // Fallback: try to get from confessions
    try {
      const snapshot = await db.collection('confessions')
        .where('status', '==', 'approved')
        .orderBy('confessionNumber', 'desc')
        .limit(1)
        .get();
      
      if (!snapshot.empty) {
        const latest = snapshot.docs[0].data();
        confessionCounter = latest.confessionNumber || 0;
      }
    } catch (fallbackError) {
      console.error('Fallback counter init also failed:', fallbackError);
      confessionCounter = 0;
    }
  }
}

// Get next confession number using Firestore transaction (atomic operation)
async function getNextConfessionNumber() {
  const counterRef = db.collection('system').doc('counters');
  
  try {
    const result = await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(counterRef);
      
      if (!doc.exists) {
        // Initialize if doesn't exist
        transaction.set(counterRef, {
          confessionNumber: 1,
          lastAssigned: new Date().toISOString()
        });
        return 1;
      }
      
      const current = doc.data().confessionNumber;
      const next = current + 1;
      
      transaction.update(counterRef, {
        confessionNumber: next,
        lastAssigned: new Date().toISOString()
      });
      
      return next;
    });
    
    return result;
  } catch (error) {
    console.error('Transaction failed: ', error);
    throw error;
  }
}

// Persistent cooldown system using Firestore - FIXED: Removed memory Map
async function checkCooldown(userId, action = 'confession', cooldownMs = 60000) {
  const cooldownRef = db.collection('user_cooldowns').doc(userId.toString());
  const doc = await cooldownRef.get();
  
  if (!doc.exists) return true; // No cooldown record, allowed
  
  const data = doc.data();
  const lastAction = data[action];
  
  if (!lastAction) return true; // No action recorded for this type, allowed
  
  return (Date.now() - lastAction) > cooldownMs; // Return true if cooldown expired
}

async function setCooldown(userId, action = 'confession') {
  const cooldownRef = db.collection('user_cooldowns').doc(userId.toString());
  await cooldownRef.set({
    [action]: Date.now(),
    updatedAt: new Date().toISOString()
  }, { merge: true });
}

// Comment rate limiting
async function checkCommentRateLimit(userId, windowMs = 30000, maxComments = 3) { // 30 seconds, 3 comments
  const rateLimitRef = db.collection('user_rate_limits').doc(userId.toString());
  const doc = await rateLimitRef.get();
  
  if (!doc.exists) return true; // No rate limit record, allowed
  
  const data = doc.data();
  const recentComments = data.commentTimestamps || [];
  
  // Filter timestamps within the window
  const now = Date.now();
  const recent = recentComments.filter(ts => (now - ts) <= windowMs);
  
  return recent.length < maxComments; // Return true if under limit
}

async function recordComment(userId) {
  const rateLimitRef = db.collection('user_rate_limits').doc(userId.toString());
  const now = Date.now();
  
  await db.runTransaction(async (transaction) => {
    const doc = await transaction.get(rateLimitRef);
    
    if (!doc.exists) {
      transaction.set(rateLimitRef, {
        commentTimestamps: [now],
        updatedAt: new Date().toISOString()
      });
    } else {
      transaction.update(rateLimitRef, {
        commentTimestamps: admin.firestore.FieldValue.arrayUnion(now),
        updatedAt: new Date().toISOString()
      });
    }
  });
  
  // Clean up old timestamps (optional cleanup)
  setTimeout(async () => {
    try {
      const doc = await rateLimitRef.get();
      if (doc.exists) {
        const data = doc.data();
        const now = Date.now();
        const recent = data.commentTimestamps.filter(ts => (now - ts) <= 30000); // 30 second window
        
        await rateLimitRef.update({
          commentTimestamps: recent
        });
      }
    } catch (error) {
      console.error('Cleanup error:', error);
    }
  }, 1000); // Cleanup after 1 second
}

// Initialize session and counter
bot.use(session());
bot.use(async (ctx, next) => {
  ctx.session = ctx.session || {};
  await next();
});

// ==================== ADMIN VERIFICATION ====================
function isAdmin(userId) {
  // Validate input
  if (!userId || typeof userId !== 'number' && typeof userId !== 'string') {
    return false;
  }
  
  const adminIds = process.env.ADMIN_IDS?.split(',').map(id => id.trim()) || [];
  return adminIds.includes(userId.toString());
}

// ==================== INPUT SANITIZATION ====================
function sanitizeInput(text) {
  if (!text) return '';
  
  // Remove potentially dangerous characters
  let sanitized = text
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') // Remove script tags
    .replace(/javascript:/gi, '') // Remove javascript protocol
    .replace(/on\w+="[^"]*"/gi, '') // Remove event handlers
    .replace(/<[^>]*>/g, '') // Remove HTML tags
    .trim();
  
  return sanitized;
}

// ==================== REPUTATION SYSTEM ====================
async function updateReputation(userId, points) {
  try {
    await db.collection('users').doc(userId.toString()).update({
      reputation: admin.firestore.FieldValue.increment(points)
    });
  } catch (error) {
    console.error('Reputation update error:', error);
    // Log error but don't fail the operation
  }
}

// ==================== ACHIEVEMENT SYSTEM ====================
async function checkAchievements(userId) {
  const profile = await getUserProfile(userId);
  
  const achievements = [];
  
  // First Confession Achievement
  if (profile.totalConfessions >= 1 && !profile.achievements?.includes('first_confession')) {
    achievements.push('first_confession');
    await awardAchievement(userId, 'first_confession', 'First Confession!');
  }
  
  // 10 Confessions Achievement
  if (profile.totalConfessions >= 10 && !profile.achievements?.includes('ten_confessions')) {
    achievements.push('ten_confessions');
    await awardAchievement(userId, 'ten_confessions', 'Confession Master (10)!');
  }
  
  // 50 Followers Achievement
  if (profile.followers?.length >= 50 && !profile.achievements?.includes('fifty_followers')) {
    achievements.push('fifty_followers');
    await awardAchievement(userId, 'fifty_followers', 'Popular User (50 followers)!');
  }
  
  // Daily Streak Achievement
  if (profile.dailyStreak >= 7 && !profile.achievements?.includes('week_streak')) {
    achievements.push('week_streak');
    await awardAchievement(userId, 'week_streak', 'Week Streak!');
  }
}

async function awardAchievement(userId, achievementId, message) {
  try {
    await db.collection('users').doc(userId.toString()).update({
      achievements: admin.firestore.FieldValue.arrayUnion(achievementId),
      achievementCount: admin.firestore.FieldValue.increment(1)
    });
    
    // Notify user about achievement
    await bot.telegram.sendMessage(userId, `🎉 Achievement Unlocked!\n\n${message}`);
  } catch (error) {
    console.error('Achievement award error:', error);
  }
}

// ==================== HASHTAG SYSTEM ====================
function extractHashtags(text) {
  const hashtagRegex = /#[a-zA-Z0-9_]+/g;
  return text.match(hashtagRegex) || [];
}

// ==================== USER PROFILE MANAGEMENT ====================
async function getUserProfile(userId) {
  const userDoc = await db.collection('users').doc(userId.toString()).get();
  
  if (!userDoc.exists) {
    // Create default profile
    const newProfile = {
      userId: userId,
      username: null,
      bio: null,
      followers: [],
      following: [],
      joinDate: new Date().toISOString(),
      totalConfessions: 0,
      reputation: 0,
      isActive: true,
      isRegistered: false,
      achievements: [],
      achievementCount: 0,
      dailyStreak: 0,
      lastCheckin: null,
      notifications: {
        confessionApproved: true,
        newComment: true,
        newFollower: true,
        newConfession: true
      },
      tags: []
    };
    
    await db.collection('users').doc(userId.toString()).set(newProfile);
    return newProfile;
  }
  
  return userDoc.data();
}

// ==================== TRENDING SYSTEM ====================
async function getTrendingConfessions(limit = 5) {
  const confessionsSnapshot = await db.collection('confessions')
    .where('status', '==', 'approved')
    .orderBy('totalComments', 'desc')
    .limit(limit)
    .get();
  
  return confessionsSnapshot.docs.map(doc => doc.data());
}

// ==================== DAILY CHECKIN SYSTEM ====================
bot.command('checkin', async (ctx) => {
  const userId = ctx.from.id;
  const profile = await getUserProfile(userId);
  
  if (!profile.isActive) {
    await ctx.reply('❌ Your account has been blocked by admin.');
    return;
  }
  
  const today = new Date().toDateString();
  const lastCheckin = profile.lastCheckin ? new Date(profile.lastCheckin).toDateString() : null;
  
  if (lastCheckin === today) {
    await ctx.reply(`✅ You already checked in today!\n\nCurrent streak: ${profile.dailyStreak} days`);
    return;
  }
  
  let newStreak = 1;
  if (lastCheckin) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    
    if (lastCheckin === yesterday.toDateString()) {
      newStreak = profile.dailyStreak + 1;
    }
  }
  
  await db.collection('users').doc(userId.toString()).update({
    dailyStreak: newStreak,
    lastCheckin: new Date().toISOString()
  });
  
  await updateReputation(userId, 2); // 2 points for daily checkin
  
  await ctx.reply(`🎉 Daily Check-in!\n\n✅ +2 reputation points\nCurrent streak: ${newStreak} days`);
  
  // Check for streak achievements
  await checkAchievements(userId);
});

// ==================== ADMIN DASHBOARD ====================
bot.command('admin', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.reply('❌ Access denied. Admin only command.');
    return;
  }
  
  const stats = await getBotStats();
  
  const text = `🔐 *Admin Dashboard*\n\n`;
  const users = `**Total Users:** ${stats.totalUsers}\n`;
  const confessions = `**Pending Confessions:** ${stats.pendingConfessions}\n`;
  const approved = `**Approved Confessions:** ${stats.approvedConfessions}\n`;
  const rejected = `**Rejected Confessions:** ${stats.rejectedConfessions}\n`;
  
  const fullText = text + users + confessions + approved + rejected;
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('👥 Manage Users', 'manage_users')],
    [Markup.button.callback('📝 Review Confessions', 'review_confessions')],
    [Markup.button.callback('📢 Broadcast Message', 'broadcast_message')],
    [Markup.button.callback('📊 Bot Statistics', 'bot_stats')],
    [Markup.button.callback('❌ Block User', 'block_user')],
    [Markup.button.callback('✅ Unblock User', 'unblock_user')]
  ]);

  await ctx.replyWithMarkdown(fullText, keyboard);
});

// Get bot statistics
async function getBotStats() {
  const usersSnapshot = await db.collection('users').get();
  const confessionsSnapshot = await db.collection('confessions').get();
  
  let pending = 0, approved = 0, rejected = 0;
  
  confessionsSnapshot.forEach(doc => {
    const data = doc.data();
    switch (data.status) {
      case 'pending': pending++; break;
      case 'approved': approved++; break;
      case 'rejected': rejected++; break;
    }
  });
  
  return {
    totalUsers: usersSnapshot.size,
    pendingConfessions: pending,
    approvedConfessions: approved,
    rejectedConfessions: rejected
  };
}

// ==================== MANAGE USERS ====================
bot.action('manage_users', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Access denied');
    return;
  }
  
  const usersSnapshot = await db.collection('users').limit(10).get();
  
  if (usersSnapshot.empty) {
    await ctx.editMessageText(
      `👥 *Manage Users*\n\nNo users found.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  
  let usersText = `👥 *Manage Users*\n\n`;
  const keyboard = [];
  
  for (const doc of usersSnapshot.docs) {
    const userData = doc.data();
    const username = userData.username || 'No username';
    const joinDate = new Date(userData.joinDate).toLocaleDateString();
    const confessions = userData.totalConfessions || 0;
    const reputation = userData.reputation || 0;
    const status = userData.isActive ? '✅ Active' : '❌ Blocked';
    
    usersText += `• ID: ${userData.userId}\n`;
    usersText += `  Username: @${username}\n`;
    usersText += `  Confessions: ${confessions}\n`;
    usersText += `  Reputation: ${reputation}\n`;
    usersText += `  Status: ${status}\n`;
    usersText += `  Joined: ${joinDate}\n\n`;
    
    keyboard.push([
      Markup.button.callback(`🔍 View @${username}`, `view_user_${userData.userId}`)
    ]);
  }
  
  keyboard.push([Markup.button.callback('🔙 Admin Menu', 'admin_menu')]);
  
  await ctx.editMessageText(usersText, { 
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard(keyboard)
  });
});

// View user details
bot.action(/view_user_(.+)/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Access denied');
    return;
  }
  
  const userId = ctx.match[1];
  const profile = await getUserProfile(userId);
  
  const text = `👤 *User Details*\n\n`;
  const id = `**User ID:** ${profile.userId}\n`;
  const username = profile.username ? `**Username:** @${profile.username}\n` : '';
  const bio = profile.bio ? `**Bio:** ${profile.bio}\n` : '';
  const followers = `**Followers:** ${profile.followers.length}\n`;
  const following = `**Following:** ${profile.following.length}\n`;
  const confessions = `**Confessions:** ${profile.totalConfessions}\n`;
  const reputation = `**Reputation:** ${profile.reputation}\n`;
  const achievements = `**Achievements:** ${profile.achievementCount}\n`;
  const streak = `**Daily Streak:** ${profile.dailyStreak} days\n`;
  const status = `**Status:** ${profile.isActive ? '✅ Active' : '❌ Blocked'}\n`;
  const joinDate = `**Join Date:** ${new Date(profile.joinDate).toLocaleDateString()}\n`;
  
  const fullText = text + id + username + bio + followers + following + confessions + reputation + achievements + streak + status + joinDate;
  
  const keyboard = [
    [Markup.button.callback('✉️ Message User', `message_${userId}`)],
    [Markup.button.callback(profile.isActive ? '❌ Block User' : '✅ Unblock User', `toggle_block_${userId}`)],
    [Markup.button.callback('👥 View Confessions', `view_user_confessions_${userId}`)],
    [Markup.button.callback('🔙 Back to Users', 'manage_users')]
  ];
  
  await ctx.editMessageText(fullText, { 
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard(keyboard)
  });
});

// Toggle user block status
bot.action(/toggle_block_(.+)/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Access denied');
    return;
  }
  
  const userId = ctx.match[1];
  const profile = await getUserProfile(userId);
  
  await db.collection('users').doc(userId.toString()).update({
    isActive: !profile.isActive
  });
  
  await ctx.answerCbQuery(profile.isActive ? '❌ User blocked!' : '✅ User unblocked!');
  
  // Update the message
  const updatedProfile = await getUserProfile(userId);
  const text = `👤 *User Details*\n\n`;
  const id = `**User ID:** ${updatedProfile.userId}\n`;
  const username = updatedProfile.username ? `**Username:** @${updatedProfile.username}\n` : '';
  const bio = updatedProfile.bio ? `**Bio:** ${updatedProfile.bio}\n` : '';
  const followers = `**Followers:** ${updatedProfile.followers.length}\n`;
  const following = `**Following:** ${updatedProfile.following.length}\n`;
  const confessions = `**Confessions:** ${updatedProfile.totalConfessions}\n`;
  const reputation = `**Reputation:** ${updatedProfile.reputation}\n`;
  const achievements = `**Achievements:** ${updatedProfile.achievementCount}\n`;
  const streak = `**Daily Streak:** ${updatedProfile.dailyStreak} days\n`;
  const status = `**Status:** ${updatedProfile.isActive ? '✅ Active' : '❌ Blocked'}\n`;
  const joinDate = `**Join Date:** ${new Date(updatedProfile.joinDate).toLocaleDateString()}\n`;
  
  const fullText = text + id + username + bio + followers + following + confessions + reputation + achievements + streak + status + joinDate;
  
  const keyboard = [
    [Markup.button.callback('✉️ Message User', `message_${userId}`)],
    [Markup.button.callback(updatedProfile.isActive ? '❌ Block User' : '✅ Unblock User', `toggle_block_${userId}`)],
    [Markup.button.callback('👥 View Confessions', `view_user_confessions_${userId}`)],
    [Markup.button.callback('🔙 Back to User', `view_user_${userId}`)]
  ];
  
  await ctx.editMessageText(fullText, { 
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard(keyboard)
  });
});

// View user confessions
bot.action(/view_user_confessions_(.+)/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Access denied');
    return;
  }
  
  const userId = ctx.match[1];
  
  const confessionsSnapshot = await db.collection('confessions')
    .where('userId', '==', parseInt(userId))
    .orderBy('createdAt', 'desc')
    .limit(10)
    .get();
  
  if (confessionsSnapshot.empty) {
    await ctx.editMessageText(
      `📝 *User Confessions*\n\nNo confessions found for this user.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  
  let confessionsText = `📝 *User Confessions*\n\n`;
  const keyboard = [];
  
  for (const doc of confessionsSnapshot.docs) {
    const data = doc.data();
    const status = data.status.charAt(0).toUpperCase() + data.status.slice(1);
    const createdAt = new Date(data.createdAt).toLocaleDateString();
    
    confessionsText += `• #${data.confessionNumber || 'N/A'} - ${status}\n`;
    confessionsText += `  Created: ${createdAt}\n`;
    confessionsText += `  "${data.text.substring(0, 50)}${data.text.length > 50 ? '...' : ''}"\n\n`;
    
    keyboard.push([
      Markup.button.callback(`🔍 View Confession #${data.confessionNumber || 'N/A'}`, `view_confession_${data.confessionId}`)
    ]);
  }
  
  keyboard.push([Markup.button.callback('🔙 Back to User', `view_user_${userId}`)]);
  
  await ctx.editMessageText(confessionsText, { 
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard(keyboard)
  });
});

// ==================== REVIEW CONFESSIONS ====================
bot.action('review_confessions', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Access denied');
    return;
  }
  
  const pendingSnapshot = await db.collection('confessions')
    .where('status', '==', 'pending')
    .orderBy('createdAt', 'asc')
    .limit(10)
    .get();
  
  if (pendingSnapshot.empty) {
    await ctx.editMessageText(
      `📝 *Pending Confessions*\n\nNo pending confessions to review.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  
  let confessionsText = `📝 *Pending Confessions*\n\n`;
  const keyboard = [];
  
  for (const doc of pendingSnapshot.docs) {
    const data = doc.data();
    const user = await getUserProfile(data.userId);
    const username = user.username ? `@${user.username}` : `ID: ${data.userId}`;
    
    confessionsText += `• From: ${username}\n`;
    confessionsText += `  Confession: "${data.text.substring(0, 50)}${data.text.length > 50 ? '...' : ''}"\n\n`;
    
    keyboard.push([
      Markup.button.callback(`✅ Approve #${doc.id}`, `approve_${doc.id}`),
      Markup.button.callback(`❌ Reject #${doc.id}`, `reject_${doc.id}`)
    ]);
  }
  
  keyboard.push([Markup.button.callback('🔙 Admin Menu', 'admin_menu')]);
  
  await ctx.editMessageText(confessionsText, { 
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard(keyboard)
  });
});

// ==================== BROADCAST MESSAGE ====================
bot.action('broadcast_message', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Access denied');
    return;
  }
  
  await ctx.editMessageText(
    `📢 *Broadcast Message*\n\nEnter your message to broadcast to all users:`,
    { parse_mode: 'Markdown' }
  );
  ctx.session.waitingForBroadcast = true;
  await ctx.answerCbQuery();
});

bot.on('text', async (ctx) => {
  // Handle confession submission
  if (ctx.session.waitingForConfession) {
    await handleConfession(ctx, ctx.message.text);
    return;
  }
  
  // Handle rejection reason
  if (ctx.session.rejectingConfession) {
    await handleRejection(ctx, ctx.message.text);
    return;
  }
  
  // Handle admin messages to users
  if (ctx.session.messagingUser) {
    await handleAdminMessage(ctx, ctx.message.text);
    return;
  }
  
  // Handle comment submission
  if (ctx.session.waitingForComment) {
    await addComment(ctx, ctx.message.text);
    return;
  }
  
  // Handle username setting
  if (ctx.session.waitingForUsername) {
    const username = ctx.message.text.trim();
    
    // Validate username
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      await ctx.reply('❌ Invalid username. Use 3-20 characters (letters, numbers, underscores only).');
      return;
    }
    
    // Check if username already exists
    const existingUsers = await db.collection('users')
      .where('username', '==', username)
      .limit(1)
      .get();
    
    if (!existingUsers.empty && existingUsers.docs[0].data().userId !== ctx.from.id) {
      await ctx.reply('❌ Username already taken. Choose another one.');
      return;
    }
    
    // Update profile
    await db.collection('users').doc(ctx.from.id.toString()).update({
      username: username
    });
    
    await ctx.reply(`✅ Username updated to @${username}`);
    ctx.session.waitingForUsername = false;
    return;
  }
  
  // Handle bio setting
  if (ctx.session.waitingForBio) {
    const bio = ctx.message.text.trim();
    
    if (bio.length > 100) {
      await ctx.reply('❌ Bio too long. Maximum 100 characters.');
      return;
    }
    
    await db.collection('users').doc(ctx.from.id.toString()).update({
      bio: bio
    });
    
    await ctx.reply('✅ Bio updated successfully!');
    ctx.session.waitingForBio = false;
    return;
  }
  
  // Handle broadcast message
  if (ctx.session.waitingForBroadcast) {
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply('❌ Access denied');
      ctx.session.waitingForBroadcast = false;
      return;
    }
    
    await broadcastMessage(ctx.message.text);
    await ctx.reply('✅ Broadcast message sent to all users!');
    ctx.session.waitingForBroadcast = false;
    return;
  }
  
  // Handle manual block
  if (ctx.session.waitingForBlockUserId) {
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply('❌ Access denied');
      ctx.session.waitingForBlockUserId = false;
      return;
    }
    
    const userId = parseInt(ctx.message.text.trim());
    if (isNaN(userId)) {
      await ctx.reply('❌ Invalid user ID. Please enter a valid number.');
      return;
    }
    
    try {
      await db.collection('users').doc(userId.toString()).update({
        isActive: false
      });
      await ctx.reply(`✅ User ${userId} has been blocked.`);
    } catch (error) {
      await ctx.reply(`❌ Error blocking user: ${error.message}`);
    }
    
    ctx.session.waitingForBlockUserId = false;
    return;
  }
  
  // Handle manual unblock
  if (ctx.session.waitingForUnblockUserId) {
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply('❌ Access denied');
      ctx.session.waitingForUnblockUserId = false;
      return;
    }
    
    const userId = parseInt(ctx.message.text.trim());
    if (isNaN(userId)) {
      await ctx.reply('❌ Invalid user ID. Please enter a valid number.');
      return;
    }
    
    try {
      await db.collection('users').doc(userId.toString()).update({
        isActive: true
      });
      await ctx.reply(`✅ User ${userId} has been unblocked.`);
    } catch (error) {
      await ctx.reply(`❌ Error unblocking user: ${error.message}`);
    }
    
    ctx.session.waitingForUnblockUserId = false;
    return;
  }
});

async function broadcastMessage(message) {
  const usersSnapshot = await db.collection('users').get();
  
  let successCount = 0;
  let failCount = 0;
  
  for (const doc of usersSnapshot.docs) {
    const userData = doc.data();
    if (userData.isActive) { // Only send to active users
      try {
        await bot.telegram.sendMessage(userData.userId, `📢 *Broadcast Message*\n\n${message}`, {
          parse_mode: 'Markdown'
        });
        successCount++;
      } catch (error) {
        failCount++;
        console.error(`Failed to send broadcast to ${userData.userId}:`, error);
      }
    }
  }
  
  console.log(`Broadcast sent: ${successCount} successful, ${failCount} failed`);
}

// ==================== BLOCK/UNBLOCK USER ====================
bot.action('block_user', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Access denied');
    return;
  }
  
  await ctx.editMessageText(
    `❌ *Block User*\n\nEnter user ID to block:`,
    { parse_mode: 'Markdown' }
  );
  ctx.session.waitingForBlockUserId = true;
  await ctx.answerCbQuery();
});

bot.action('unblock_user', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Access denied');
    return;
  }
  
  await ctx.editMessageText(
    `✅ *Unblock User*\n\nEnter user ID to unblock:`,
    { parse_mode: 'Markdown' }
  );
  ctx.session.waitingForUnblockUserId = true;
  await ctx.answerCbQuery();
});

// ==================== BOT STATISTICS ====================
bot.action('bot_stats', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Access denied');
    return;
  }
  
  const stats = await getBotStats();
  
  const text = `📊 *Bot Statistics*\n\n`;
  const users = `**Total Users:** ${stats.totalUsers}\n`;
  const confessions = `**Pending Confessions:** ${stats.pendingConfessions}\n`;
  const approved = `**Approved Confessions:** ${stats.approvedConfessions}\n`;
  const rejected = `**Rejected Confessions:** ${stats.rejectedConfessions}\n`;
  const total = `**Total Confessions:** ${stats.pendingConfessions + stats.approvedConfessions + stats.rejectedConfessions}\n`;
  
  const fullText = text + users + confessions + approved + rejected + total;
  
  const keyboard = [
    [Markup.button.callback('👥 Manage Users', 'manage_users')],
    [Markup.button.callback('📝 Review Confessions', 'review_confessions')],
    [Markup.button.callback('🔙 Admin Menu', 'admin_menu')]
  ];
  
  await ctx.editMessageText(fullText, { 
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard(keyboard)
  });
});

// ==================== ADMIN MENU RETURN ====================
bot.action('admin_menu', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Access denied');
    return;
  }
  
  const stats = await getBotStats();
  
  const text = `🔐 *Admin Dashboard*\n\n`;
  const users = `**Total Users:** ${stats.totalUsers}\n`;
  const confessions = `**Pending Confessions:** ${stats.pendingConfessions}\n`;
  const approved = `**Approved Confessions:** ${stats.approvedConfessions}\n`;
  const rejected = `**Rejected Confessions:** ${stats.rejectedConfessions}\n`;
  
  const fullText = text + users + confessions + approved + rejected;
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('👥 Manage Users', 'manage_users')],
    [Markup.button.callback('📝 Review Confessions', 'review_confessions')],
    [Markup.button.callback('📢 Broadcast Message', 'broadcast_message')],
    [Markup.button.callback('📊 Bot Statistics', 'bot_stats')],
    [Markup.button.callback('❌ Block User', 'block_user')],
    [Markup.button.callback('✅ Unblock User', 'unblock_user')]
  ]);

  await ctx.editMessageText(fullText, { 
    parse_mode: 'Markdown',
    reply_markup: keyboard.reply_markup 
  });
  await ctx.answerCbQuery();
});

// ==================== FIRST TIME WELCOME ====================
bot.command('start', async (ctx) => {
  const args = ctx.message.text.split(' ')[1];
  
  if (args && args.startsWith('comments_')) {
    const confessionId = args.replace('comments_', '');
    await showComments(ctx, confessionId);
    return;
  }
  
  // Get user profile
  const profile = await getUserProfile(ctx.from.id);
  
  if (!profile.isActive) {
    await ctx.reply('❌ Your account has been blocked by admin.');
    return;
  }
  
  // Check if user is first-time user
  if (!profile.isRegistered) {
    // Update user as registered
    await db.collection('users').doc(ctx.from.id.toString()).update({
      isRegistered: true
    });
    
    // Send first-time welcome message with inline button
    const welcomeText = `🤫 *Welcome to JU Confession Bot!*\n\nSend me your confession and it will be submitted anonymously for admin approval.\n\nYour identity will never be revealed!`;
    
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('Continue', 'continue_to_bot')]
    ]);
    
    await ctx.replyWithMarkdown(welcomeText, keyboard);
    return;
  }
  
  // Regular menu for existing users
  await showMainMenu(ctx);
});

// Handle first-time continue button
bot.action('continue_to_bot', async (ctx) => {
  await showMainMenu(ctx);
  await ctx.answerCbQuery();
});

// ==================== CONSTANT NAVIGATION BUTTONS ====================
async function showMainMenu(ctx) {
  const profile = await getUserProfile(ctx.from.id);
  
  const text = `🤫 *JU Confession Bot*\n\n`;
  const stats = `👤 Profile: ${profile.username || 'Not set'}\n`;
  const reputation = `⭐ Reputation: ${profile.reputation}\n`;
  const streak = `🔥 Streak: ${profile.dailyStreak} days\n`;
  const bio = profile.bio ? `📝 Bio: ${profile.bio}\n` : '';
  
  const fullText = text + stats + reputation + streak + bio + `\nChoose an option below:`;
  
  // Constant navigation buttons (not inline)
  const keyboard = Markup.keyboard([
    ['📝 Send Confession', '👤 My Profile'],
    ['🔥 Trending', '🎯 Daily Check-in'],
    ['🏷️ Hashtags', '🏆 Achievements'],
    ['⚙️ Settings', 'ℹ️ About Us'],
    ['🔍 Browse Users', '📌 Rules']
  ]).resize();
  
  await ctx.replyWithMarkdown(fullText, keyboard);
}

// ==================== COMMAND HANDLERS ====================
bot.hears('📝 Send Confession', async (ctx) => {
  await sendConfessionCommand(ctx);
});

bot.hears('👤 My Profile', async (ctx) => {
  await myProfileCommand(ctx);
});

bot.hears('🔥 Trending', async (ctx) => {
  await trendingCommand(ctx);
});

bot.hears('🎯 Daily Check-in', async (ctx) => {
  await ctx.reply('/checkin');
});

bot.hears('🏷️ Hashtags', async (ctx) => {
  await hashtagsCommand(ctx);
});

bot.hears('🏆 Achievements', async (ctx) => {
  await achievementsCommand(ctx);
});

bot.hears('⚙️ Settings', async (ctx) => {
  await settingsCommand(ctx);
});

bot.hears('ℹ️ About Us', async (ctx) => {
  await aboutUsCommand(ctx);
});

bot.hears('🔍 Browse Users', async (ctx) => {
  await browseUsersCommand(ctx);
});

bot.hears('📌 Rules', async (ctx) => {
  await rulesCommand(ctx);
});

// Individual command functions
async function sendConfessionCommand(ctx) {
  const userId = ctx.from.id;
  
  // Check if user is active
  const profile = await getUserProfile(userId);
  if (!profile.isActive) {
    await ctx.reply('❌ Your account has been blocked by admin.');
    return;
  }
  
  // Check cooldown using persistent system
  const canSubmit = await checkCooldown(userId, 'confession', 60000); // 1 minute cooldown
  if (!canSubmit) {
    const cooldownRef = await db.collection('user_cooldowns').doc(userId.toString()).get();
    if (cooldownRef.exists) {
      const data = cooldownRef.data();
      const lastSubmit = data.confession || 0;
      const waitTime = Math.ceil((60000 - (Date.now() - lastSubmit)) / 1000);
      await ctx.reply(`Please wait ${waitTime} seconds before submitting another confession.`);
      return;
    }
  }

  await ctx.replyWithMarkdown(
    `✍️ *Send Your Confession*\n\nType your confession below (max 1000 characters):\n\nYou can add hashtags like #love #study #funny`
  );
  
  ctx.session.waitingForConfession = true;
}

async function myProfileCommand(ctx) {
  const profile = await getUserProfile(ctx.from.id);
  
  const profileText = `👤 *Your Profile*\n\n`;
  const username = profile.username ? `**Username:** @${profile.username}\n` : `**Username:** Not set\n`;
  const bio = profile.bio ? `**Bio:** ${profile.bio}\n` : `**Bio:** Not set\n`;
  const followers = `**Followers:** ${profile.followers.length}\n`;
  const following = `**Following:** ${profile.following.length}\n`;
  const confessions = `**Total Confessions:** ${profile.totalConfessions}\n`;
  const reputation = `**Reputation:** ${profile.reputation}\n`;
  const achievements = `**Achievements:** ${profile.achievementCount}\n`;
  const streak = `**Daily Streak:** ${profile.dailyStreak} days\n`;
  const joinDate = `**Member Since:** ${new Date(profile.joinDate).toLocaleDateString()}\n`;
  
  const fullText = profileText + username + bio + followers + following + confessions + reputation + achievements + streak + joinDate;
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📝 Set Username', 'set_username')],
    [Markup.button.callback('📝 Set Bio', 'set_bio')],
    [Markup.button.callback('👥 Followers', 'show_followers')],
    [Markup.button.callback('👥 Following', 'show_following')],
    [Markup.button.callback('🏆 View Achievements', 'view_achievements')],
    [Markup.button.callback('🔍 Browse Users', 'browse_users')],
    [Markup.button.callback('🔙 Back to Menu', 'back_to_menu')]
  ]);

  await ctx.replyWithMarkdown(fullText, keyboard);
}

async function trendingCommand(ctx) {
  const trending = await getTrendingConfessions(5);
  
  if (trending.length === 0) {
    await ctx.reply('No trending confessions yet. Be the first to submit one!');
    return;
  }
  
  let trendingText = `🔥 *Trending Confessions*\n\n`;
  
  trending.forEach((confession, index) => {
    trendingText += `${index + 1}. #${confession.confessionNumber}\n`;
    trendingText += `   ${confession.text.substring(0, 100)}${confession.text.length > 100 ? '...' : ''}\n`;
    trendingText += `   Comments: ${confession.totalComments || 0}\n\n`;
  });
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📝 Send Confession', 'send_confession')],
    [Markup.button.callback('🔍 Browse Users', 'browse_users')],
    [Markup.button.callback('🔙 Back to Menu', 'back_to_menu')]
  ]);

  await ctx.replyWithMarkdown(trendingText, keyboard);
}

async function hashtagsCommand(ctx) {
  // Get popular hashtags from recent confessions
  const confessionsSnapshot = await db.collection('confessions')
    .where('status', '==', 'approved')
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get();
  
  const hashtagCount = {};
  
  confessionsSnapshot.forEach(doc => {
    const data = doc.data();
    const hashtags = extractHashtags(data.text);
    hashtags.forEach(tag => {
      hashtagCount[tag] = (hashtagCount[tag] || 0) + 1;
    });
  });
  
  // Sort hashtags by count
  const sortedHashtags = Object.entries(hashtagCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  
  if (sortedHashtags.length === 0) {
    await ctx.reply('No hashtags found yet. Use #hashtags in your confessions!');
    return;
  }
  
  let hashtagsText = `🏷️ *Popular Hashtags*\n\n`;
  
  sortedHashtags.forEach(([tag, count], index) => {
    hashtagsText += `${index + 1}. ${tag} (${count} uses)\n`;
  });
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📝 Send Confession', 'send_confession')],
    [Markup.button.callback('🔍 Browse Users', 'browse_users')],
    [Markup.button.callback('🔙 Back to Menu', 'back_to_menu')]
  ]);

  await ctx.replyWithMarkdown(hashtagsText, keyboard);
}

async function achievementsCommand(ctx) {
  const profile = await getUserProfile(ctx.from.id);
  
  const achievements = profile.achievements || [];
  
  if (achievements.length === 0) {
    await ctx.reply('No achievements yet. Start using the bot to unlock achievements!');
    return;
  }
  
  let achievementsText = `🏆 *Your Achievements*\n\n`;
  
  const achievementNames = {
    'first_confession': 'First Confession',
    'ten_confessions': 'Confession Master',
    'fifty_followers': 'Popular User',
    'week_streak': 'Week Streak'
  };
  
  achievements.forEach(achievement => {
    achievementsText += `• ${achievementNames[achievement] || achievement}\n`;
  });
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🎯 Daily Check-in', 'daily_checkin')],
    [Markup.button.callback('📝 Send Confession', 'send_confession')],
    [Markup.button.callback('🔙 Back to Menu', 'back_to_menu')]
  ]);

  await ctx.replyWithMarkdown(achievementsText, keyboard);
}

async function settingsCommand(ctx) {
  const profile = await getUserProfile(ctx.from.id);
  
  const text = `⚙️ *Settings*\n\nConfigure your bot preferences:\n\n`;
  const notifications = `**Notifications:** ${profile.notifications.confessionApproved ? '✅' : '❌'} Confession Approved\n`;
  const comments = `**Comments:** ${profile.notifications.newComment ? '✅' : '❌'} New Comments\n`;
  const followers = `**Followers:** ${profile.notifications.newFollower ? '✅' : '❌'} New Followers\n`;
  
  const fullText = text + notifications + comments + followers;
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📝 Set Username', 'set_username')],
    [Markup.button.callback('📝 Set Bio', 'set_bio')],
    [Markup.button.callback('🔍 Browse Users', 'browse_users')],
    [Markup.button.callback('🔙 Back to Menu', 'back_to_menu')]
  ]);

  await ctx.replyWithMarkdown(fullText, keyboard);
}

async function aboutUsCommand(ctx) {
  const text = `ℹ️ *About Us*\n\nThis is an anonymous confession platform for JU students.\n\nFeatures:\n• Anonymous confessions\n• Admin approval system\n• User profiles\n• Social features\n• Comment system\n• Reputation system\n• Achievements\n• Daily check-ins\n\n100% private and secure.`;
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📝 Send Confession', 'send_confession')],
    [Markup.button.callback('🎯 Daily Check-in', 'daily_checkin')],
    [Markup.button.callback('🔍 Browse Users', 'browse_users')],
    [Markup.button.callback('🔙 Back to Menu', 'back_to_menu')]
  ]);

  await ctx.replyWithMarkdown(text, keyboard);
}

async function browseUsersCommand(ctx) {
  // Get all users except current user
  const usersSnapshot = await db.collection('users')
    .where('username', '!=', null) // Only users with usernames
    .where('isActive', '==', true) // Only active users
    .orderBy('reputation', 'desc') // Sort by reputation
    .limit(10)
    .get();
  
  if (usersSnapshot.empty) {
    await ctx.reply(
      `🔍 *Browse Users*\n\nNo users found.`
    );
    return;
  }
  
  let usersText = `🔍 *Browse Users*\n\n`;
  const keyboard = [];
  
  for (const doc of usersSnapshot.docs) {
    const userData = doc.data();
    if (userData.userId === ctx.from.id) continue; // Skip current user
    
    const name = userData.username;
    const bio = userData.bio || 'No bio';
    const followers = userData.followers.length;
    const reputation = userData.reputation;
    
    usersText += `• @${name} (${reputation}⭐, ${followers} followers)\n`;
    usersText += `  ${bio}\n\n`;
    
    keyboard.push([
      Markup.button.callback(`👤 View @${name}`, `view_profile_${userData.userId}`)
    ]);
  }
  
  keyboard.push([Markup.button.callback('🔙 Back to Menu', 'back_to_menu')]);
  
  await ctx.replyWithMarkdown(usersText, Markup.inlineKeyboard(keyboard));
}

async function rulesCommand(ctx) {
  const text = `📌 *Confession Rules*\n\n✅ Be respectful\n✅ No personal attacks\n✅ No spam or ads\n✅ Keep it anonymous\n✅ No hate speech\n✅ No illegal content\n✅ No harassment\n✅ Use appropriate hashtags`;
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📝 Send Confession', 'send_confession')],
    [Markup.button.callback('🎯 Daily Check-in', 'daily_checkin')],
    [Markup.button.callback('🔍 Browse Users', 'browse_users')],
    [Markup.button.callback('🔙 Back to Menu', 'back_to_menu')]
  ]);

  await ctx.replyWithMarkdown(text, keyboard);
}

// Back to menu action
bot.action('back_to_menu', async (ctx) => {
  await showMainMenu(ctx);
  await ctx.answerCbQuery();
});

// Daily check-in action
bot.action('daily_checkin', async (ctx) => {
  await ctx.reply('/checkin');
  await ctx.answerCbQuery();
});

// View achievements action
bot.action('view_achievements', async (ctx) => {
  await achievementsCommand(ctx);
  await ctx.answerCbQuery();
});

// ==================== MY PROFILE ACTIONS ====================
bot.action('show_followers', async (ctx) => {
  const profile = await getUserProfile(ctx.from.id);
  const followerIds = profile.followers || [];
  
  if (followerIds.length === 0) {
    await ctx.editMessageText(
      `👥 *Your Followers*\n\nNo followers yet.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  
  let followersText = `👥 *Your Followers (${followerIds.length})*\n\n`;
  
  for (const followerId of followerIds) {
    const followerProfile = await getUserProfile(followerId);
    const name = followerProfile.username || 'Anonymous';
    const reputation = followerProfile.reputation;
    followersText += `• @${name} (${reputation}⭐)\n`;
  }
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔍 Browse Users', 'browse_users')],
    [Markup.button.callback('🔙 Back to Menu', 'back_to_menu')]
  ]);
  
  await ctx.editMessageText(followersText, { 
    parse_mode: 'Markdown',
    reply_markup: keyboard.reply_markup 
  });
});

bot.action('show_following', async (ctx) => {
  const profile = await getUserProfile(ctx.from.id);
  const followingIds = profile.following || [];
  
  if (followingIds.length === 0) {
    await ctx.editMessageText(
      `👥 *You're Following*\n\nNot following anyone yet.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  
  let followingText = `👥 *You're Following (${followingIds.length})*\n\n`;
  
  for (const followingId of followingIds) {
    const followingProfile = await getUserProfile(followingId);
    const name = followingProfile.username || 'Anonymous';
    const reputation = followingProfile.reputation;
    followingText += `• @${name} (${reputation}⭐)\n`;
  }
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔍 Browse Users', 'browse_users')],
    [Markup.button.callback('🔙 Back to Menu', 'back_to_menu')]
  ]);
  
  await ctx.editMessageText(followingText, { 
    parse_mode: 'Markdown',
    reply_markup: keyboard.reply_markup 
  });
});

// ==================== BROWSE USERS ====================
bot.action('browse_users', async (ctx) => {
  // Get all users except current user
  const usersSnapshot = await db.collection('users')
    .where('username', '!=', null) // Only users with usernames
    .where('isActive', '==', true) // Only active users
    .orderBy('reputation', 'desc') // Sort by reputation
    .limit(10)
    .get();
  
  if (usersSnapshot.empty) {
    await ctx.editMessageText(
      `🔍 *Browse Users*\n\nNo users found.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  
  let usersText = `🔍 *Browse Users*\n\n`;
  const keyboard = [];
  
  for (const doc of usersSnapshot.docs) {
    const userData = doc.data();
    if (userData.userId === ctx.from.id) continue; // Skip current user
    
    const name = userData.username;
    const bio = userData.bio || 'No bio';
    const followers = userData.followers.length;
    const reputation = userData.reputation;
    
    usersText += `• @${name} (${reputation}⭐, ${followers} followers)\n`;
    usersText += `  ${bio}\n\n`;
    
    keyboard.push([
      Markup.button.callback(`👤 View @${name}`, `view_profile_${userData.userId}`)
    ]);
  }
  
  keyboard.push([Markup.button.callback('🔙 Back to Menu', 'back_to_menu')]);
  
  await ctx.editMessageText(usersText, { 
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard(keyboard)
  });
});

// ==================== VIEW USER PROFILE ====================
bot.action(/view_profile_(.+)/, async (ctx) => {
  const targetUserId = ctx.match[1];
  const targetProfile = await getUserProfile(targetUserId);
  const currentUserProfile = await getUserProfile(ctx.from.id);
  
  const profileText = `👤 *Profile*\n\n`;
  const username = targetProfile.username ? `**Username:** @${targetProfile.username}\n` : '';
  const bio = targetProfile.bio ? `**Bio:** ${targetProfile.bio}\n` : `**Bio:** No bio\n`;
  const followers = `**Followers:** ${targetProfile.followers.length}\n`;
  const following = `**Following:** ${targetProfile.following.length}\n`;
  const confessions = `**Confessions:** ${targetProfile.totalConfessions}\n`;
  const reputation = `**Reputation:** ${targetProfile.reputation}⭐\n`;
  const achievements = `**Achievements:** ${targetProfile.achievementCount}\n`;
  const joinDate = `**Member Since:** ${new Date(targetProfile.joinDate).toLocaleDateString()}\n`;
  
  const fullText = profileText + username + bio + followers + following + confessions + reputation + achievements + joinDate;
  
  // Check if user is already following
  const isFollowing = currentUserProfile.following.includes(parseInt(targetUserId));
  
  const keyboard = [
    [isFollowing 
      ? Markup.button.callback('✅ Following', `unfollow_${targetUserId}`)
      : Markup.button.callback('➕ Follow', `follow_${targetUserId}`)
    ]
  ];
  
  keyboard.push([Markup.button.callback('🔙 Back to Menu', 'back_to_menu')]);
  
  await ctx.editMessageText(fullText, { 
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard(keyboard)
  });
});

// ==================== FOLLOW/UNFOLLOW ====================
bot.action(/follow_(.+)/, async (ctx) => {
  const targetUserId = parseInt(ctx.match[1]);
  
  if (targetUserId === ctx.from.id) {
    await ctx.answerCbQuery('❌ You cannot follow yourself');
    return;
  }
  
  try {
    // Add to current user's following
    await db.collection('users').doc(ctx.from.id.toString()).update({
      following: admin.firestore.FieldValue.arrayUnion(targetUserId)
    });
    
    // Add to target user's followers
    await db.collection('users').doc(targetUserId.toString()).update({
      followers: admin.firestore.FieldValue.arrayUnion(ctx.from.id)
    });
    
    await ctx.answerCbQuery('✅ Following!');
    
    // Update the message
    const targetProfile = await getUserProfile(targetUserId);
    const profileText = `👤 *Profile*\n\n`;
    const username = targetProfile.username ? `**Username:** @${targetProfile.username}\n` : '';
    const bio = targetProfile.bio ? `**Bio:** ${targetProfile.bio}\n` : `**Bio:** No bio\n`;
    const followers = `**Followers:** ${targetProfile.followers.length + 1}\n`;
    const following = `**Following:** ${targetProfile.following.length}\n`;
    const confessions = `**Confessions:** ${targetProfile.totalConfessions}\n`;
    const reputation = `**Reputation:** ${targetProfile.reputation}⭐\n`;
    const achievements = `**Achievements:** ${targetProfile.achievementCount}\n`;
    const joinDate = `**Member Since:** ${new Date(targetProfile.joinDate).toLocaleDateString()}\n`;
    
    const fullText = profileText + username + bio + followers + following + confessions + reputation + achievements + joinDate;
    
    const keyboard = [
      [Markup.button.callback('✅ Following', `unfollow_${targetUserId}`)],
      [Markup.button.callback('🔙 Back to Menu', 'back_to_menu')]
    ];
    
    await ctx.editMessageText(fullText, { 
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard(keyboard)
    });
    
  } catch (error) {
    console.error('Follow error:', error);
    await ctx.answerCbQuery('❌ Error following user');
  }
});

bot.action(/unfollow_(.+)/, async (ctx) => {
  const targetUserId = parseInt(ctx.match[1]);
  
  try {
    // Remove from current user's following
    await db.collection('users').doc(ctx.from.id.toString()).update({
      following: admin.firestore.FieldValue.arrayRemove(targetUserId)
    });
    
    // Remove from target user's followers
    await db.collection('users').doc(targetUserId.toString()).update({
      followers: admin.firestore.FieldValue.arrayRemove(ctx.from.id)
    });
    
    await ctx.answerCbQuery('❌ Unfollowed');
    
    // Update the message
    const targetProfile = await getUserProfile(targetUserId);
    const profileText = `👤 *Profile*\n\n`;
    const username = targetProfile.username ? `**Username:** @${targetProfile.username}\n` : '';
    const bio = targetProfile.bio ? `**Bio:** ${targetProfile.bio}\n` : `**Bio:** No bio\n`;
    const followers = `**Followers:** ${Math.max(0, targetProfile.followers.length - 1)}\n`;
    const following = `**Following:** ${targetProfile.following.length}\n`;
    const confessions = `**Confessions:** ${targetProfile.totalConfessions}\n`;
    const reputation = `**Reputation:** ${targetProfile.reputation}⭐\n`;
    const achievements = `**Achievements:** ${targetProfile.achievementCount}\n`;
    const joinDate = `**Member Since:** ${new Date(targetProfile.joinDate).toLocaleDateString()}\n`;
    
    const fullText = profileText + username + bio + followers + following + confessions + reputation + achievements + joinDate;
    
    const keyboard = [
      [Markup.button.callback('➕ Follow', `follow_${targetUserId}`)],
      [Markup.button.callback('🔙 Back to Menu', 'back_to_menu')]
    ];
    
    await ctx.editMessageText(fullText, { 
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard(keyboard)
    });
    
  } catch (error) {
    console.error('Unfollow error:', error);
    await ctx.answerCbQuery('❌ Error unfollowing user');
  }
});

// ==================== SET USERNAME ====================
bot.action('set_username', async (ctx) => {
  await ctx.editMessageText(
    `📝 *Set Username*\n\nEnter your desired username (without @):\n\nMust be 3-20 characters, letters/numbers/underscores only.`,
    { parse_mode: 'Markdown' }
  );
  ctx.session.waitingForUsername = true;
  await ctx.answerCbQuery();
});

// ==================== SET BIO ====================
bot.action('set_bio', async (ctx) => {
  await ctx.editMessageText(
    `📝 *Set Bio*\n\nEnter your bio (max 100 characters):`,
    { parse_mode: 'Markdown' }
  );
  ctx.session.waitingForBio = true;
  await ctx.answerCbQuery();
});

// ==================== SEND CONFESSION ====================
bot.action('send_confession', async (ctx) => {
  await sendConfessionCommand(ctx);
  await ctx.answerCbQuery();
});

async function handleConfession(ctx, text) {
  const userId = ctx.from.id;

  // Validate confession
  if (!text || text.trim().length < 5) {
    await ctx.reply('❌ Confession too short. Minimum 5 characters.');
    ctx.session.waitingForConfession = false;
    return;
  }

  if (text.length > 1000) {
    await ctx.reply('❌ Confession too long. Maximum 1000 characters.');
    ctx.session.waitingForConfession = false;
    return;
  }

  try {
    // Sanitize input
    const sanitizedText = sanitizeInput(text);
    
    // Generate confession ID (confession number will be assigned during approval)
    const confessionId = `confess_${userId}_${Date.now()}`;
    
    // Extract hashtags
    const hashtags = extractHashtags(sanitizedText);
    
    // Save to Firebase - FIXED: Removed confessionNumber from pending confessions
    await db.collection('confessions').doc(confessionId).set({
      confessionId: confessionId,
      userId: userId,
      text: sanitizedText.trim(),
      status: 'pending',
      createdAt: new Date().toISOString(),
      hashtags: hashtags,
      totalComments: 0
    });

    // Update user profile
    await db.collection('users').doc(userId.toString()).update({
      totalConfessions: admin.firestore.FieldValue.increment(1)
    });

    // Set persistent cooldown
    await setCooldown(userId, 'confession');

    // Notify admin
    await notifyAdmins(confessionId, sanitizedText);
    
    ctx.session.waitingForConfession = false;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('📝 Send Another', 'send_confession')],
      [Markup.button.callback('🎯 Daily Check-in', 'daily_checkin')],
      [Markup.button.callback('🔙 Back to Menu', 'back_to_menu')]
    ]);

    await ctx.replyWithMarkdown(
      `✅ *Confession Submitted!*\n\nYour confession is under review. You'll be notified when approved.`,
      keyboard
    );
    
    // Check for achievements
    await checkAchievements(userId);
    
  } catch (error) {
    console.error('Submission error:', error);
    await ctx.reply('❌ Error submitting confession. Please try again.');
    ctx.session.waitingForConfession = false;
  }
}

// ==================== ADMIN NOTIFICATION ====================
async function notifyAdmins(confessionId, text) {
  const adminIds = process.env.ADMIN_IDS?.split(',').map(id => id.trim()) || [];
  
  const message = `🤫 *New Confession*\n\n${text}\n\n*Actions:*`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Approve', `approve_${confessionId}`),
      Markup.button.callback('❌ Reject', `reject_${confessionId}`)
    ]
  ]);

  for (const adminId of adminIds) {
    try {
      await bot.telegram.sendMessage(adminId, message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard.reply_markup
      });
    } catch (error) {
      console.error(`Admin notify error ${adminId}:`, error);
    }
  }
}

// ==================== ADMIN APPROVAL ====================
bot.action(/approve_(.+)/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Access denied');
    return;
  }
  
  const confessionId = ctx.match[1];
  
  try {
    const doc = await db.collection('confessions').doc(confessionId).get();
    if (!doc.exists) {
      await ctx.answerCbQuery('❌ Confession not found');
      return;
    }

    const confession = doc.data();
    
    // FIXED: Get next confession number from Firestore (only during approval)
    const nextNumber = await getNextConfessionNumber();
    
    // Update confession with assigned number
    await db.collection('confessions').doc(confessionId).update({
      status: 'approved',
      confessionNumber: nextNumber, // FIXED: Assign number during approval only
      approvedAt: new Date().toISOString()
    });

    // Post to channel WITH PROPER COMMENT BUTTONS
    await postToChannel(confession.text, nextNumber, confessionId);

    // Update reputation (10 points for approved confession)
    await updateReputation(confession.userId, 10);

    // Notify user
    await notifyUser(confession.userId, nextNumber, 'approved');

    // Update admin message
    await ctx.editMessageText(
      `✅ *Confession #${nextNumber} Approved!*\n\nPosted to channel successfully.`,
      { parse_mode: 'Markdown' }
    );
    
    await ctx.answerCbQuery('Approved!');

    // Check for achievements
    await checkAchievements(confession.userId);

  } catch (error) {
    console.error('Approval error:', error);
    await ctx.answerCbQuery('❌ Approval failed');
  }
});

// ==================== ADMIN REJECTION ====================
bot.action(/reject_(.+)/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Access denied');
    return;
  }
  
  const confessionId = ctx.match[1];
  
  await ctx.editMessageText(
    `❌ *Rejecting Confession*\n\nPlease provide rejection reason:`,
    { parse_mode: 'Markdown' }
  );
  ctx.session.rejectingConfession = confessionId;
  await ctx.answerCbQuery();
});

async function handleRejection(ctx, reason) {
  const confessionId = ctx.session.rejectingConfession;
  
  try {
    const doc = await db.collection('confessions').doc(confessionId).get();
    if (doc.exists) {
      const confession = doc.data();
      
      await db.collection('confessions').doc(confessionId).update({
        status: 'rejected',
        rejectionReason: reason,
        rejectedAt: new Date().toISOString()
      });

      // Notify user
      await notifyUser(confession.userId, 0, 'rejected', reason);

      await ctx.reply(`✅ Confession rejected.`);
    }
  } catch (error) {
    console.error('Rejection error:', error);
    await ctx.reply('❌ Rejection failed');
  }
  
  ctx.session.rejectingConfession = null;
}

// ==================== CHANNEL POSTING WITH COMMENT SYSTEM ====================
async function postToChannel(text, number, confessionId) {
  const channelId = process.env.CHANNEL_ID;
  
  const message = `#${number}\n\n${text}`;

  try {
    // Send the confession to channel
    const channelMessage = await bot.telegram.sendMessage(channelId, message);
    
    // Create a comment button that redirects to bot
    const commentButton = Markup.inlineKeyboard([
      [Markup.button.url('👁️‍🗨️ View/Add Comments', `https://t.me/${bot.botInfo.username}?start=comments_${confessionId}`)]
    ]);

    // Edit the message to add comment button
    await bot.telegram.editMessageText(
      channelId,
      channelMessage.message_id,
      undefined,
      `${message}\n\n[ 👁️‍🗨️ View/Add Comments (0) ]`, // This is just text, not a button
      commentButton
    );

    // Create a separate comment section in bot
    await createCommentSection(confessionId, number, text);
    
  } catch (error) {
    console.error('Channel post error:', error);
  }
}

// ==================== COMMENT SYSTEM ====================
async function createCommentSection(confessionId, number, confessionText) {
  // Create a document to store comments
  await db.collection('comments').doc(confessionId).set({
    confessionId: confessionId,
    confessionNumber: number,
    confessionText: confessionText,
    comments: [],
    totalComments: 0
  });
}

// Show comments for a confession
async function showComments(ctx, confessionId) {
  try {
    const commentDoc = await db.collection('comments').doc(confessionId).get();
    if (!commentDoc.exists) {
      await ctx.reply('❌ Confession not found.');
      return;
    }

    const data = commentDoc.data();
    const comments = data.comments || [];
    
    let commentText = `💬 Comments for Confession #${data.confessionNumber}\n\n`;
    
    if (comments.length === 0) {
      commentText += 'No comments yet. Be the first to comment!\n\n';
    } else {
      commentText += `Total Comments: ${comments.length}\n\n`;
      comments.forEach((comment, index) => {
        commentText += `${index + 1}. ${comment.text}\n`;
        commentText += `   - ${comment.timestamp}\n\n`;
      });
    }

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('📝 Add Comment', `add_comment_${confessionId}`)],
      [Markup.button.callback('🔄 Refresh', `refresh_comments_${confessionId}`)],
      [Markup.button.callback('🎯 Daily Check-in', 'daily_checkin')],
      [Markup.button.callback('🔙 Back to Menu', 'back_to_menu')]
    ]);

    await ctx.replyWithMarkdown(commentText, keyboard);
  } catch (error) {
    console.error('Show comments error:', error);
    await ctx.reply('❌ Error loading comments.');
  }
}

// Handle comment actions
bot.action(/^add_comment_(.+)$/, async (ctx) => {
  const confessionId = ctx.match[1];
  
  await ctx.editMessageText(
    `📝 *Add Comment*\n\nType your comment for this confession:`,
    { parse_mode: 'Markdown' }
  );
  
  ctx.session.waitingForComment = confessionId;
  await ctx.answerCbQuery();
});

bot.action(/^refresh_comments_(.+)$/, async (ctx) => {
  const confessionId = ctx.match[1];
  await showComments(ctx, confessionId);
  await ctx.answerCbQuery();
});

async function addComment(ctx, commentText) {
  const userId = ctx.from.id;
  const confessionId = ctx.session.waitingForComment;
  
  if (!commentText || commentText.trim().length < 3) {
    await ctx.reply('❌ Comment too short. Minimum 3 characters.');
    return;
  }

  try {
    // FIXED: Add comment rate limiting
    const canComment = await checkCommentRateLimit(userId);
    if (!canComment) {
      await ctx.reply('❌ Too many comments. Please wait before adding another comment.');
      return;
    }

    const commentDoc = await db.collection('comments').doc(confessionId).get();
    if (!commentDoc.exists) {
      await ctx.reply('❌ Confession not found.');
      return;
    }

    // Sanitize comment text
    const sanitizedComment = sanitizeInput(commentText);

    const commentData = {
      id: `comment_${Date.now()}_${userId}`,
      text: sanitizedComment.trim(),
      userId: userId,
      userName: ctx.from.first_name,
      timestamp: new Date().toLocaleString(),
      createdAt: new Date().toISOString()
    };

    // Use transaction to ensure both updates happen together
    await db.runTransaction(async (transaction) => {
      const commentRef = db.collection('comments').doc(confessionId);
      const confessionRef = db.collection('confessions').doc(confessionId);
      
      transaction.update(commentRef, {
        comments: admin.firestore.FieldValue.arrayUnion(commentData),
        totalComments: admin.firestore.FieldValue.increment(1)
      });
      
      transaction.update(confessionRef, {
        totalComments: admin.firestore.FieldValue.increment(1)
      });
    });

    // FIXED: Record comment for rate limiting
    await recordComment(userId);

    // Update reputation for commenting (5 points)
    await updateReputation(userId, 5);

    await ctx.reply('✅ Comment added successfully!');
    
    // Show updated comments
    await showComments(ctx, confessionId);
    
    // Clear session
    ctx.session.waitingForComment = null;
    
    // Check for achievements
    await checkAchievements(userId);
    
  } catch (error) {
    console.error('Add comment error:', error);
    await ctx.reply('❌ Error adding comment.');
  }
}

// ==================== USER NOTIFICATION ====================
async function notifyUser(userId, number, status, reason = '') {
  try {
    let message = '';
    if (status === 'approved') {
      message = `🎉 *Your Confession #${number} was approved!*\n\nIt has been posted to the channel.\n\n⭐ +10 reputation points`;
    } else {
      message = `❌ *Confession Not Approved*\n\nReason: ${reason}\n\nYou can submit a new one.`;
    }

    await bot.telegram.sendMessage(userId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('User notify error:', error);
  }
}

// ==================== ADMIN MESSAGING ====================
bot.action(/message_(.+)/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('❌ Access denied');
    return;
  }
  
  const userId = ctx.match[1];
  await ctx.editMessageText(`📩 Messaging user ID: ${userId}\n\nType your message:`);
  ctx.session.messagingUser = userId;
  await ctx.answerCbQuery();
});

async function handleAdminMessage(ctx, text) {
  const userId = ctx.session.messagingUser;

  try {
    await bot.telegram.sendMessage(userId, `📩 *Admin Message*\n\n${text}`, { parse_mode: 'Markdown' });
    await ctx.reply(`✅ Message sent to user ID: ${userId}`);
  } catch (error) {
    await ctx.reply(`❌ Failed to send message to user ID: ${userId}. User may have blocked bot.`);
  }
  
  ctx.session.messagingUser = null;
}

// ==================== ERROR HANDLING ====================
bot.catch((err, ctx) => {
  console.error(`Bot error:`, err);
  ctx.reply('❌ An error occurred. Please try again.');
});

// ==================== VERCEL HANDLER ====================
module.exports = async (req, res) => {
  try {
    // Initialize counter on first request (or after restart)
    if (confessionCounter === 0) {
      await initializeCounter();
    }
    
    await bot.handleUpdate(req.body);
    res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).send('Error');
  }
};

// ==================== LOCAL DEVELOPMENT ====================
if (process.env.NODE_ENV === 'development') {
  initializeCounter().then(() => {
    bot.launch().then(() => {
      console.log('🤫 JU Confession Bot running locally');
    });
  });
  
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
        }
