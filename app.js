const STORAGE_KEY = "ielts-dictation-v1";
const SETTINGS_KEY = "ielts-dictation-settings-v1";

const els = Object.fromEntries([
  "practiceView", "reviewView", "answerForm", "answerInput", "answerReveal", "phonetic", "meaning",
  "wordStatus", "instruction", "queueLabel", "feedback", "speakButton", "slowButton", "previousButton",
  "progressBar", "progressText", "correctCount", "reviewBadge", "reviewTable", "emptyReview",
  "statLearning", "statDue", "statMastered", "statAccuracy", "practiceMistakesButton", "settingsButton",
  "settingsDialog", "voiceSelect", "speechRate", "rateOutput", "autoSpeak", "saveSettings", "resetProgress",
  "groupSelect", "groupComplete", "nextGroupButton", "syncStatus", "practiceMode", "historyModeOption",
  "repeatSessionButton", "returnNormalButton", "customDialog", "customForm", "closeCustomButton",
  "customStartGroup", "customEndGroup", "customFilter", "customLimit", "customPreview", "startCustomButton",
  "star1FilterOption", "star3FilterOption", "star5FilterOption", "reportButton", "feedbackDialog",
  "feedbackForm", "closeFeedbackButton", "feedbackWordId", "feedbackTerm", "feedbackMeaning",
  "issuePronunciation", "issueMeaning", "issueSpelling", "feedbackSuggestedTerm",
  "feedbackSuggestedMeaning", "feedbackPronunciationQuery", "feedbackNote", "submitFeedbackButton"
].map(id => [id, document.getElementById(id)]));
els.startOverlay = document.getElementById("startOverlay");
els.startButton = document.getElementById("startButton");

const defaultSettings = { speechRate: 0.9, voiceName: "", autoSpeak: true };
let settings = { ...defaultSettings, ...readJSON(SETTINGS_KEY, {}) };
let progress = readJSON(STORAGE_KEY, { words: {}, attempts: 0, correct: 0 });
let words = [];
let session = [];
let currentIndex = 0;
let sessionCorrect = 0;
let sessionGroup = 1;
let sessionMode = "normal";
let lastCustomConfig = null;
let locked = false;
let voices = [];
let history = [];
let lastAnsweredWord = null;
let audioUnlocked = false;
let audioContext = null;
let activeAudioSource = null;
let playbackToken = 0;
const audioBufferCache = new Map();
let serverSyncQueue = Promise.resolve();
const onlineAudio = document.getElementById("pronunciationAudio");
onlineAudio.preload = "auto";
window.__dictationAudio = onlineAudio;
window.__dictationAudioState = "idle";
function setAudioState(state) {
  window.__dictationAudioState = state;
  document.documentElement.dataset.audioState = state;
}
onlineAudio.addEventListener("loadstart", () => setAudioState("loading"));
onlineAudio.addEventListener("canplay", () => setAudioState("ready"));
onlineAudio.addEventListener("playing", () => setAudioState("playing"));
onlineAudio.addEventListener("ended", () => setAudioState("ended"));
onlineAudio.addEventListener("error", () => setAudioState(`error-${onlineAudio.error?.code || "unknown"}`));

function readJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; }
}

function saveProgress(wordId = null, attempt = null) {
  progress.updatedAt = Date.now();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  const changedWords = wordId && progress.words[wordId] ? { [wordId]: progress.words[wordId] } : {};
  queueServerSync({ meta: progressMeta(), words: changedWords, attempt });
}

function progressMeta() {
  return {
    attempts: progress.attempts || 0,
    correct: progress.correct || 0,
    currentGroup: progress.currentGroup || 1,
    updatedAt: progress.updatedAt || 0,
  };
}

function apiHeaders() {
  const headers = { "Content-Type": "application/json" };
  const queryToken = new URLSearchParams(location.search).get("token");
  if (queryToken) localStorage.setItem("dictation-access-token", queryToken);
  const token = queryToken || localStorage.getItem("dictation-access-token");
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function setSyncStatus(text, state = "") {
  els.syncStatus.textContent = text;
  els.syncStatus.className = `sync-status ${state}`.trim();
}

function queueServerSync(payload) {
  setSyncStatus("正在保存", "pending");
  serverSyncQueue = serverSyncQueue
    .then(async () => {
      const response = await fetch("/api/progress", {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`同步失败：${response.status}`);
      setSyncStatus("已保存");
    })
    .catch(() => setSyncStatus("本地待同步", "error"));
}

async function uploadAllProgress() {
  const response = await fetch("/api/progress", {
    method: "POST",
    headers: apiHeaders(),
    body: JSON.stringify({ meta: progressMeta(), words: progress.words || {}, replace: true }),
  });
  if (!response.ok) throw new Error(`迁移失败：${response.status}`);
}

async function restoreServerProgress() {
  try {
    const response = await fetch("/api/progress", { headers: apiHeaders() });
    if (!response.ok) throw new Error(`读取失败：${response.status}`);
    const server = await response.json();
    const localHasData = (progress.attempts || 0) > 0 || Object.keys(progress.words || {}).length > 0;
    if (!server.exists) {
      if (localHasData) {
        if (!progress.updatedAt) progress.updatedAt = Date.now();
        await uploadAllProgress();
      }
    } else {
      const localWordCount = Object.keys(progress.words || {}).length;
      const serverWordCount = Object.keys(server.progress.words || {}).length;
      const legacyLocalIsMoreComplete = !progress.updatedAt && localHasData
        && ((progress.attempts || 0) > (server.progress.attempts || 0) || localWordCount > serverWordCount);
      if (legacyLocalIsMoreComplete || (progress.updatedAt || 0) > (server.progress.updatedAt || 0)) {
        progress.updatedAt = Date.now();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
        await uploadAllProgress();
      } else {
        progress = server.progress;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
      }
    }
    setSyncStatus("已保存");
  } catch {
    setSyncStatus("本地待同步", "error");
  }
}

function queueServerReset() {
  setSyncStatus("正在清空", "pending");
  serverSyncQueue = serverSyncQueue
    .then(async () => {
      const response = await fetch("/api/progress", { method: "DELETE", headers: apiHeaders() });
      if (!response.ok) throw new Error(`清空失败：${response.status}`);
      setSyncStatus("已保存");
    })
    .catch(() => setSyncStatus("本地待同步", "error"));
}
function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }

function parseWordList(text) {
  return text.split(/\r?\n/).map(line => {
    const head = line.match(/^P(\d+)\s+(\d+)\s+(.+)$/);
    if (!head) return null;
    const parts = head[3].trim().split(/\s{2,}/).map(part => part.trim()).filter(Boolean);
    let term = parts[0];
    let phonetic = "";
    let meaning = "";
    if (parts.length === 1) {
      return { id: `P${head[1]}-${head[2]}`, part: Number(head[1]), number: Number(head[2]), term, phonetic, meaning };
    } else if (parts.length === 2 && /^(n\.|v\.|a\.|ad\.|prep\.|conj\.|pron\.|num\.|pl\.|\[)/i.test(parts[1])) {
      meaning = parts[1];
    } else {
      phonetic = parts[1] || "";
      meaning = parts.slice(2).join(" ");
    }
    return { id: `P${head[1]}-${head[2]}`, part: Number(head[1]), number: Number(head[2]), term, phonetic, meaning };
  }).filter(Boolean);
}

function getState(id) {
  return progress.words[id] || { status: "new", reviewStreak: 0, dueAt: 0, wrongCount: 0, dismissed: false };
}

function focusLevel(state) {
  const wrongCount = state.wrongCount || 0;
  if (wrongCount >= 4) return 5;
  if (wrongCount >= 3) return 3;
  if (wrongCount >= 2) return 1;
  return 0;
}

function focusLabel(state) {
  const level = focusLevel(state);
  return level ? `${level} 星重点` : "普通错题";
}

function focusBadgeHTML(state) {
  const level = focusLevel(state);
  return `<span class="star-badge star-${level}">${level ? `${"★".repeat(level)} ${level}星` : "普通"}</span>`;
}

function buildSession(mode = "normal", customConfig = null) {
  const now = Date.now();
  const due = words.filter(word => {
    const state = getState(word.id);
    return !state.dismissed && state.status === "learning" && state.dueAt <= now;
  });
  const totalGroups = Math.ceil(words.length / 30);
  const selectedGroup = Math.min(Math.max(Number(progress.currentGroup) || 1, 1), totalGroups);
  progress.currentGroup = selectedGroup;
  sessionGroup = selectedGroup;
  sessionMode = mode;
  lastCustomConfig = mode === "custom" ? customConfig : lastCustomConfig;
  if (mode === "mistakes") {
    const learning = words.filter(word => {
      const state = getState(word.id);
      return !state.dismissed && state.status === "learning";
    });
    session = shuffle(learning);
  } else if (mode === "history") {
    session = shuffle(words.filter(word => {
      const state = getState(word.id);
      return !state.dismissed && (state.wrongCount || 0) > 0;
    }));
  } else if (mode === "custom") {
    const config = customConfig || lastCustomConfig || { startGroup: 1, endGroup: totalGroups, filter: "all", limit: 30 };
    const start = (Math.min(config.startGroup, config.endGroup) - 1) * 30;
    const end = Math.max(config.startGroup, config.endGroup) * 30;
    const candidates = words.slice(start, end).filter(word => matchesCustomFilter(word, config.filter));
    session = shuffle(candidates).slice(0, Math.max(1, config.limit || candidates.length));
  } else {
    const groupStart = (selectedGroup - 1) * 30;
    const groupWords = words.slice(groupStart, groupStart + 30).filter(word => {
      const state = getState(word.id);
      return !state.dismissed && state.status === "new";
    });
    const merged = new Map([...due, ...groupWords].map(word => [word.id, word]));
    session = shuffle([...merged.values()]);
  }
  currentIndex = 0;
  sessionCorrect = 0;
  history = [];
  saveProgress();
  els.practiceMode.value = mode === "history" || mode === "custom" ? mode : "normal";
  els.groupSelect.disabled = mode !== "normal";
  renderQuestion();
}

function matchesCustomFilter(word, filter) {
  const state = getState(word.id);
  if (state.dismissed) return false;
  if (filter === "wrong") return (state.wrongCount || 0) > 0;
  if (filter === "star1") return (state.wrongCount || 0) >= 2;
  if (filter === "star3") return (state.wrongCount || 0) >= 3;
  if (filter === "star5") return (state.wrongCount || 0) >= 4;
  if (filter === "learning") return state.status === "learning";
  if (filter === "mastered") return state.status === "mastered";
  if (filter === "new") return state.status === "new";
  return true;
}

function modeLabel() {
  if (sessionMode === "history") return "曾经错过";
  if (sessionMode === "custom") return "自定义练习";
  if (sessionMode === "mistakes") return "当前错题复习";
  return `第 ${sessionGroup} 组`;
}

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function currentWord() { return session[currentIndex]; }

function renderQuestion() {
  locked = false;
  els.answerInput.value = "";
  els.answerInput.disabled = false;
  els.feedback.textContent = session.length ? "按回车提交" : "本组已完成";
  els.feedback.className = "feedback";
  els.groupComplete.hidden = true;
  const word = currentWord();
  const done = Math.min(currentIndex, session.length);
  els.progressText.textContent = `${done} / ${session.length}`;
  els.progressBar.style.width = session.length ? `${done / session.length * 100}%` : "100%";
  els.correctCount.textContent = sessionCorrect;
  els.previousButton.disabled = history.length === 0;
  if (!word) {
    els.startOverlay.hidden = true;
    const totalGroups = Math.ceil(words.length / 30);
    els.instruction.textContent = sessionMode === "normal" ? `第 ${sessionGroup} 组完成` : `${modeLabel()}完成`;
    els.queueLabel.textContent = sessionMode === "normal" ? "本组学习结束" : "本次练习结束";
    els.answerInput.disabled = true;
    els.answerForm.style.visibility = "hidden";
    els.groupComplete.hidden = false;
    els.nextGroupButton.hidden = sessionMode !== "normal" || sessionGroup >= totalGroups;
    els.repeatSessionButton.hidden = sessionMode === "normal";
    els.returnNormalButton.hidden = sessionMode === "normal";
    updateStats();
    return;
  }
  els.answerForm.style.visibility = "visible";
  const state = getState(word.id);
  if (sessionMode === "history") {
    els.queueLabel.textContent = `曾经错过 · ${focusLabel(state)} · 累计错 ${state.wrongCount || 0} 次`;
  } else if (sessionMode === "custom") {
    els.queueLabel.textContent = `自定义练习 · ${focusLabel(state)} · ${currentIndex + 1}/${session.length}`;
  } else if (sessionMode === "mistakes") {
    els.queueLabel.textContent = `当前错题复习 · 已答对 ${state.reviewStreak}/2 次`;
  } else {
    els.queueLabel.textContent = state.status === "learning" ? `第 ${sessionGroup} 组 · 错题复习 ${state.reviewStreak}/2` : `第 ${sessionGroup} 组 · 新词`;
  }
  els.instruction.textContent = "根据发音写出单词或短语";
  els.answerInput.focus();
  const upcomingWord = session[currentIndex + 1];
  if (upcomingWord && audioUnlocked) preloadAudio(upcomingWord);
  if (settings.autoSpeak && audioUnlocked) setTimeout(() => speak(false), 180);
}

function normalize(value) {
  return value.trim().toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ");
}

function submitAnswer(event) {
  event.preventDefault();
  if (locked || !currentWord() || !els.answerInput.value.trim()) return;
  locked = true;
  const word = currentWord();
  const submitted = els.answerInput.value.trim();
  const given = normalize(submitted);
  const expected = normalize(word.term);
  const isCorrect = given === expected;
  history.push({ index: currentIndex, answer: els.answerInput.value });
  progress.attempts += 1;
  if (isCorrect) {
    progress.correct += 1;
    sessionCorrect += 1;
    if (shouldApplyCorrectProgress(word)) handleCorrect(word);
    showResult(word, submitted, true);
    playTone(true);
  } else {
    handleWrong(word);
    showResult(word, submitted, false);
    playTone(false);
  }
  saveProgress(word.id, {
    wordId: word.id,
    submittedAnswer: els.answerInput.value,
    expectedAnswer: word.term,
    isCorrect,
    answeredAt: Date.now(),
  });
  updateStats();
  setTimeout(() => { currentIndex += 1; renderQuestion(); }, isCorrect ? 850 : 1800);
}

function shouldApplyCorrectProgress(word) {
  if (sessionMode === "normal" || sessionMode === "mistakes") return true;
  const state = getState(word.id);
  if (state.status === "new") return true;
  return state.status === "learning" && state.dueAt <= Date.now();
}

function handleCorrect(word) {
  const state = getState(word.id);
  if (state.status === "learning") {
    state.reviewStreak += 1;
    if (state.reviewStreak >= 2) {
      state.status = "mastered";
      state.dueAt = 0;
    } else {
      state.dueAt = Date.now() + 20 * 60 * 60 * 1000;
    }
  } else {
    state.status = "mastered";
    state.reviewStreak = 0;
  }
  state.lastAnswerAt = Date.now();
  progress.words[word.id] = state;
}

function handleWrong(word) {
  const state = getState(word.id);
  state.status = "learning";
  state.reviewStreak = 0;
  state.wrongCount = (state.wrongCount || 0) + 1;
  state.dueAt = Date.now() + 10 * 60 * 1000;
  state.lastAnswerAt = Date.now();
  progress.words[word.id] = state;
}

function showResult(word, given, isCorrect) {
  els.answerInput.disabled = true;
  lastAnsweredWord = word;
  els.wordStatus.textContent = isCorrect ? "拼写正确" : `你的答案：${given}`;
  els.answerReveal.innerHTML = isCorrect
    ? `<span class="right">${escapeHTML(word.term)}</span>`
    : diffAnswer(word.term, given);
  els.answerReveal.disabled = false;
  els.answerReveal.title = `点击播放 ${word.term} 的发音`;
  els.answerReveal.setAttribute("aria-label", `点击播放 ${word.term} 的发音`);
  els.reportButton.disabled = false;
  els.reportButton.title = `反馈 ${word.term}`;
  els.phonetic.textContent = word.phonetic ? `/${word.phonetic}/` : "";
  els.meaning.textContent = word.meaning;
  els.feedback.textContent = isCorrect ? "正确，即将进入下一题" : "红色位置需要注意，即将进入下一题";
  els.feedback.className = `feedback ${isCorrect ? "correct" : "incorrect"}`;
}

function openFeedbackDialog() {
  if (!lastAnsweredWord) return;
  els.feedbackWordId.value = lastAnsweredWord.id;
  els.feedbackTerm.textContent = lastAnsweredWord.term;
  els.feedbackMeaning.textContent = lastAnsweredWord.meaning || "暂无释义";
  els.issuePronunciation.checked = false;
  els.issueMeaning.checked = false;
  els.issueSpelling.checked = false;
  els.feedbackSuggestedTerm.value = lastAnsweredWord.term;
  els.feedbackSuggestedMeaning.value = lastAnsweredWord.meaning || "";
  els.feedbackPronunciationQuery.value = lastAnsweredWord.term;
  els.feedbackNote.value = "";
  els.submitFeedbackButton.disabled = false;
  els.submitFeedbackButton.textContent = "提交反馈";
  els.feedbackDialog.showModal();
}

async function submitFeedback(event) {
  event.preventDefault();
  if (!lastAnsweredWord) return;
  const issueTypes = [
    ["pronunciation", els.issuePronunciation],
    ["meaning", els.issueMeaning],
    ["spelling", els.issueSpelling],
  ].filter(([, input]) => input.checked).map(([type]) => type);
  if (!issueTypes.length) {
    els.feedback.textContent = "请先选择反馈类型";
    els.feedback.className = "feedback incorrect";
    return;
  }
  const payload = {
    wordId: lastAnsweredWord.id,
    term: lastAnsweredWord.term,
    phonetic: lastAnsweredWord.phonetic || "",
    meaning: lastAnsweredWord.meaning || "",
    issueTypes,
    suggestedTerm: els.feedbackSuggestedTerm.value.trim(),
    suggestedMeaning: els.feedbackSuggestedMeaning.value.trim(),
    pronunciationQuery: els.feedbackPronunciationQuery.value.trim(),
    note: els.feedbackNote.value.trim(),
  };
  els.submitFeedbackButton.disabled = true;
  els.submitFeedbackButton.textContent = "提交中";
  try {
    const response = await fetch("/api/feedback", {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`反馈失败：${response.status}`);
    els.feedbackDialog.close();
    els.feedback.textContent = "反馈已保存";
    els.feedback.className = "feedback correct";
    setSyncStatus("反馈已保存");
  } catch (error) {
    els.submitFeedbackButton.disabled = false;
    els.submitFeedbackButton.textContent = "提交反馈";
    els.feedback.textContent = error.message;
    els.feedback.className = "feedback incorrect";
  }
}

function diffAnswer(expected, actual) {
  const original = [...expected];
  const a = original.map(comparisonChar);
  const b = [...actual].map(comparisonChar);
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  }
  const matched = new Set();
  let i = a.length, j = b.length;
  while (i && j) {
    if (a[i - 1] === b[j - 1]) { matched.add(i - 1); i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) i--; else j--;
  }
  return original.map((char, index) => `<span class="${matched.has(index) ? "right" : "wrong"}">${escapeHTML(char)}</span>`).join("");
}

function comparisonChar(char) {
  return char.toLowerCase().replace(/[’‘]/g, "'");
}

function escapeHTML(value) {
  return value.replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function chooseVoice() {
  if (!("speechSynthesis" in window)) return null;
  return voices.find(v => v.name === settings.voiceName)
    || voices.find(v => v.lang.toLowerCase() === "en-gb")
    || voices.find(v => v.lang.toLowerCase().startsWith("en-gb"))
    || voices.find(v => v.lang.toLowerCase().startsWith("en"));
}

async function speak(slow = false) {
  audioUnlocked = true;
  els.startOverlay.hidden = true;
  const word = currentWord();
  if (!word) return;
  await speakWord(word, slow);
}

async function speakWord(word, slow = false) {
  audioUnlocked = true;
  els.startOverlay.hidden = true;
  const token = ++playbackToken;
  setAudioState("loading");
  try {
    const context = await ensureAudioContext();
    const buffer = await loadAudioBuffer(word);
    if (token !== playbackToken) return;
    if (activeAudioSource) {
      try { activeAudioSource.stop(); } catch {}
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = slow ? Math.max(.7, settings.speechRate - .2) : settings.speechRate;
    source.connect(context.destination);
    source.onended = () => {
      if (token === playbackToken) setAudioState("ended");
    };
    activeAudioSource = source;
    document.documentElement.dataset.audioContext = context.state;
    setAudioState("playing");
    source.start(0);
  } catch {
    playWithHtmlAudio(word, slow);
  }
}

async function ensureAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error("Web Audio is not supported");
  if (!audioContext) audioContext = new AudioContextClass();
  if (audioContext.state === "suspended") await audioContext.resume();
  document.documentElement.dataset.audioContext = audioContext.state;
  if (audioContext.state !== "running") throw new Error(`Audio context is ${audioContext.state}`);
  return audioContext;
}

async function loadAudioBuffer(word) {
  if (audioBufferCache.has(word.id)) return audioBufferCache.get(word.id);
  const response = await fetch(`audio/${encodeURIComponent(word.id)}.mp3`);
  if (!response.ok) throw new Error(`Audio file returned ${response.status}`);
  const context = await ensureAudioContext();
  const buffer = await context.decodeAudioData(await response.arrayBuffer());
  audioBufferCache.set(word.id, buffer);
  if (audioBufferCache.size > 8) audioBufferCache.delete(audioBufferCache.keys().next().value);
  return buffer;
}

function preloadAudio(word) {
  loadAudioBuffer(word).catch(() => {});
}

async function playWithHtmlAudio(word, slow) {
  onlineAudio.pause();
  onlineAudio.src = `audio/${encodeURIComponent(word.id)}.mp3`;
  onlineAudio.playbackRate = slow ? Math.max(.7, settings.speechRate - .2) : settings.speechRate;
  try {
    await onlineAudio.play();
  } catch {
    speakWithSystemVoice(word.term, slow);
  }
}

function speakWithSystemVoice(term, slow) {
  if (!("speechSynthesis" in window)) {
    els.feedback.textContent = "联网发音暂时不可用，请检查网络后再点一次喇叭";
    return;
  }
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(term);
  const voice = chooseVoice();
  if (voice) utterance.voice = voice;
  utterance.lang = "en-GB";
  utterance.rate = slow ? Math.max(.55, settings.speechRate - .25) : settings.speechRate;
  utterance.pitch = 1;
  speechSynthesis.speak(utterance);
}

function playTone(correct) {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  const ctx = new AudioContext();
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.connect(gain); gain.connect(ctx.destination);
  oscillator.type = correct ? "sine" : "triangle";
  oscillator.frequency.setValueAtTime(correct ? 620 : 210, ctx.currentTime);
  if (correct) oscillator.frequency.setValueAtTime(820, ctx.currentTime + .1);
  gain.gain.setValueAtTime(.12, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + .28);
  oscillator.start(); oscillator.stop(ctx.currentTime + .3);
}

function updateStats() {
  const states = Object.values(progress.words).filter(state => !state.dismissed);
  const now = Date.now();
  const learning = states.filter(state => state.status === "learning");
  const mastered = states.filter(state => state.status === "mastered");
  const due = learning.filter(state => state.dueAt <= now);
  const everWrong = states.filter(state => (state.wrongCount || 0) > 0);
  const star1 = states.filter(state => (state.wrongCount || 0) >= 2);
  const star3 = states.filter(state => (state.wrongCount || 0) >= 3);
  const star5 = states.filter(state => (state.wrongCount || 0) >= 4);
  els.reviewBadge.textContent = learning.length;
  els.statLearning.textContent = learning.length;
  els.statDue.textContent = due.length;
  els.statMastered.textContent = mastered.length;
  els.statAccuracy.textContent = progress.attempts ? `${Math.round(progress.correct / progress.attempts * 100)}%` : "0%";
  els.historyModeOption.textContent = `曾经错过（${everWrong.length}）`;
  els.star1FilterOption.textContent = `1 星重点（${star1.length}，含 3/5 星）`;
  els.star3FilterOption.textContent = `3 星重点（${star3.length}，含 5 星）`;
  els.star5FilterOption.textContent = `5 星重点（${star5.length}）`;
  els.reviewTable.innerHTML = "";
  words.filter(word => {
    const state = getState(word.id);
    return !state.dismissed && state.status === "learning";
  }).slice(0, 200).forEach(word => {
    const state = getState(word.id);
    const row = document.createElement("tr");
    row.innerHTML = `<td>${escapeHTML(word.term)}</td><td>${focusBadgeHTML(state)}</td><td>${escapeHTML(word.meaning || "-")}</td><td>${state.reviewStreak} / 2</td><td>${formatDue(state.dueAt)}</td><td><button class="remove-word-button" type="button" data-word-id="${escapeHTML(word.id)}" title="从错题记录中删除">删除</button></td>`;
    els.reviewTable.appendChild(row);
  });
  els.emptyReview.hidden = learning.length > 0;
}

function dismissWrongWord(wordId) {
  const word = words.find(item => item.id === wordId);
  if (!word || !confirm(`确定删除“${word.term}”吗？删除后它将退出所有错题和星级复习。`)) return;
  const state = getState(wordId);
  progress.words[wordId] = {
    ...state,
    status: "mastered",
    reviewStreak: 0,
    dueAt: 0,
    wrongCount: 0,
    dismissed: true,
  };
  saveProgress(wordId);
  updateStats();
}

function formatDue(timestamp) {
  if (timestamp <= Date.now()) return "现在";
  const diff = timestamp - Date.now();
  if (diff < 60 * 60 * 1000) return `${Math.ceil(diff / 60000)} 分钟后`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.ceil(diff / 3600000)} 小时后`;
  return new Date(timestamp).toLocaleDateString("zh-CN");
}

function switchView(view) {
  const practice = view === "practice";
  els.practiceView.hidden = !practice;
  els.reviewView.hidden = practice;
  document.body.classList.toggle("practice-active", practice);
  document.querySelectorAll(".nav-button").forEach(btn => btn.classList.toggle("active", btn.dataset.view === view));
  if (!practice) updateStats(); else setTimeout(() => els.answerInput.focus(), 0);
}

function loadVoices() {
  if (!("speechSynthesis" in window)) {
    els.voiceSelect.innerHTML = '<option value="">联网英音（推荐）</option>';
    return;
  }
  voices = speechSynthesis.getVoices();
  const english = voices.filter(voice => voice.lang.toLowerCase().startsWith("en"));
  els.voiceSelect.innerHTML = '<option value="">联网英音（推荐）</option>' + english.map(voice => `<option value="${escapeHTML(voice.name)}">${escapeHTML(voice.name)} · ${voice.lang}</option>`).join("");
  if (settings.voiceName && english.some(v => v.name === settings.voiceName)) els.voiceSelect.value = settings.voiceName;
  else if (chooseVoice()) els.voiceSelect.value = chooseVoice().name;
}

function openSettings() {
  els.speechRate.value = settings.speechRate;
  els.rateOutput.value = `${settings.speechRate.toFixed(2)}×`;
  els.autoSpeak.checked = settings.autoSpeak;
  loadVoices();
  els.settingsDialog.showModal();
}

function customConfigFromForm() {
  return {
    startGroup: Number(els.customStartGroup.value),
    endGroup: Number(els.customEndGroup.value),
    filter: els.customFilter.value,
    limit: Number(els.customLimit.value),
  };
}

function customCandidateCount() {
  if (!words.length) return 0;
  const config = customConfigFromForm();
  const start = (Math.min(config.startGroup, config.endGroup) - 1) * 30;
  const end = Math.max(config.startGroup, config.endGroup) * 30;
  return words.slice(start, end).filter(word => matchesCustomFilter(word, config.filter)).length;
}

function updateCustomPreview() {
  const count = customCandidateCount();
  const requested = Math.max(1, Number(els.customLimit.value) || 1);
  els.customPreview.textContent = count
    ? `符合条件 ${count} 个，本次随机练习 ${Math.min(count, requested)} 个`
    : "当前范围没有符合条件的单词";
  els.startCustomButton.disabled = count === 0;
}

function openCustomDialog() {
  const current = String(progress.currentGroup || 1);
  els.customStartGroup.value = current;
  els.customEndGroup.value = current;
  updateCustomPreview();
  els.customDialog.showModal();
}

els.answerForm.addEventListener("submit", submitAnswer);
els.speakButton.addEventListener("click", () => speak(false));
els.slowButton.addEventListener("click", () => speak(true));
els.startButton.addEventListener("click", () => speak(false));
els.answerReveal.addEventListener("click", () => {
  if (lastAnsweredWord) speakWord(lastAnsweredWord, false);
});
els.reportButton.addEventListener("click", openFeedbackDialog);
els.closeFeedbackButton.addEventListener("click", () => els.feedbackDialog.close());
els.feedbackForm.addEventListener("submit", submitFeedback);
els.settingsButton.addEventListener("click", openSettings);
els.speechRate.addEventListener("input", () => els.rateOutput.value = `${Number(els.speechRate.value).toFixed(2)}×`);
els.saveSettings.addEventListener("click", () => {
  settings = { speechRate: Number(els.speechRate.value), voiceName: els.voiceSelect.value, autoSpeak: els.autoSpeak.checked };
  saveSettings();
});
els.resetProgress.addEventListener("click", () => {
  if (!confirm("确定清空全部学习记录吗？此操作无法撤销。")) return;
  progress = { words: {}, attempts: 0, correct: 0, currentGroup: 1 };
  els.groupSelect.value = "1";
  progress.updatedAt = Date.now();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  queueServerReset(); updateStats(); buildSession(); els.settingsDialog.close();
});
els.practiceMistakesButton.addEventListener("click", () => { switchView("practice"); buildSession("mistakes"); });
els.reviewTable.addEventListener("click", event => {
  const button = event.target.closest(".remove-word-button");
  if (button) dismissWrongWord(button.dataset.wordId);
});
els.practiceMode.addEventListener("change", () => {
  const mode = els.practiceMode.value;
  if (mode === "custom") {
    openCustomDialog();
    return;
  }
  switchView("practice");
  buildSession(mode);
});
els.groupSelect.addEventListener("change", () => {
  progress.currentGroup = Number(els.groupSelect.value);
  saveProgress();
  switchView("practice");
  buildSession();
});
els.nextGroupButton.addEventListener("click", () => {
  const totalGroups = Math.ceil(words.length / 30);
  progress.currentGroup = Math.min(sessionGroup + 1, totalGroups);
  els.groupSelect.value = String(progress.currentGroup);
  saveProgress();
  buildSession();
});
els.repeatSessionButton.addEventListener("click", () => buildSession(sessionMode, lastCustomConfig));
els.returnNormalButton.addEventListener("click", () => buildSession("normal"));
els.closeCustomButton.addEventListener("click", () => {
  els.customDialog.close();
  els.practiceMode.value = sessionMode === "history" ? "history" : sessionMode === "custom" ? "custom" : "normal";
});
els.customForm.addEventListener("submit", event => {
  event.preventDefault();
  const config = customConfigFromForm();
  if (!customCandidateCount()) return;
  els.customDialog.close();
  switchView("practice");
  buildSession("custom", config);
});
[els.customStartGroup, els.customEndGroup, els.customFilter, els.customLimit].forEach(control => {
  control.addEventListener("input", updateCustomPreview);
  control.addEventListener("change", updateCustomPreview);
});
els.previousButton.addEventListener("click", () => {
  if (!history.length || locked) return;
  const previous = history.pop();
  currentIndex = previous.index;
  renderQuestion();
  els.answerInput.value = previous.answer;
});
document.querySelectorAll(".nav-button").forEach(button => button.addEventListener("click", () => switchView(button.dataset.view)));
document.addEventListener("keydown", event => {
  if (event.key === "Tab" && !els.settingsDialog.open) { event.preventDefault(); speak(false); }
});
if ("speechSynthesis" in window) speechSynthesis.addEventListener("voiceschanged", loadVoices);

const wordListSource = window.WORDLIST_TEXT
  ? Promise.resolve(window.WORDLIST_TEXT)
  : fetch("wordlist.txt").then(response => { if (!response.ok) throw new Error("无法加载词库"); return response.text(); });

wordListSource
  .then(async text => {
    words = parseWordList(text);
    if (!words.length) throw new Error("词库格式无法识别");
    await restoreServerProgress();
    const totalGroups = Math.ceil(words.length / 30);
    els.groupSelect.innerHTML = Array.from({ length: totalGroups }, (_, index) => {
      const start = index * 30 + 1;
      const end = Math.min((index + 1) * 30, words.length);
      return `<option value="${index + 1}">第 ${index + 1} 组 · ${start}-${end}</option>`;
    }).join("");
    const compactGroupOptions = Array.from({ length: totalGroups }, (_, index) => `<option value="${index + 1}">第 ${index + 1} 组</option>`).join("");
    els.customStartGroup.innerHTML = compactGroupOptions;
    els.customEndGroup.innerHTML = compactGroupOptions;
    progress.currentGroup = Math.min(Math.max(Number(progress.currentGroup) || 1, 1), totalGroups);
    els.groupSelect.value = String(progress.currentGroup);
    updateStats();
    document.body.classList.add("practice-active");
    buildSession();
    loadVoices();
  })
  .catch(error => {
    els.instruction.textContent = "词库加载失败";
    els.feedback.textContent = error.message;
    els.answerInput.disabled = true;
  });
