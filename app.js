// =========================================================
// QUESTBOARD — app.js
// Static, no-backend multi-user study board.
//   - Firebase Firestore: real-time shared task/points data
//   - Firebase Anonymous Auth: lightweight identity (no signup)
//   - Gemini API: checks that a "proof of work" submission is a
//     genuine, on-topic completion (NOT graded for correctness)
// =========================================================

firebase.initializeApp(FIREBASE_CONFIG);
const auth = firebase.auth();
const db = firebase.firestore();

let currentUser = null;      // { uid, name }
let quests = [];             // live cache of quest docs
let users = [];              // live cache of user docs
let privateQuests = [];      // live cache of THIS user's private quest docs
let activeProofQuestId = null;

// ---------------------------------------------------------
// ANTI-FARMING SETTINGS
// ---------------------------------------------------------

const MAX_BASE_POINTS = 50;     // hard cap on what any single quest can be worth
// Approvals/rejections needed to resolve a pending quest scale with guild
// size (see requiredApprovalsFor) rather than a fixed number.

// Fixed lifetime for every quest — once this many days have passed since
// posting, the quest drops off the board for everyone (except someone with
// an unfinished claim still in progress on it — see isExpired()/renderQuests()).
const QUEST_LIFETIME_DAYS = 7;

// ---------------------------------------------------------
// DOM refs
// ---------------------------------------------------------

const loginScreen = document.getElementById("loginScreen");
const appScreen = document.getElementById("appScreen");
const loginForm = document.getElementById("loginForm");
const nameInput = document.getElementById("nameInput");
const loginError = document.getElementById("loginError");

const meLevel = document.getElementById("meLevel");
const meName = document.getElementById("meName");
const meXpFill = document.getElementById("meXpFill");
const mePoints = document.getElementById("mePoints");

const questList = document.getElementById("questList");
const emptyState = document.getElementById("emptyState");
const pendingBanner = document.getElementById("pendingBanner");
const leaderboardEl = document.getElementById("leaderboard");

const newQuestBtn = document.getElementById("newQuestBtn");
const questModal = document.getElementById("questModal");
const closeQuestModal = document.getElementById("closeQuestModal");
const questForm = document.getElementById("questForm");
const qStatus = document.getElementById("qStatus");
const questSubmitBtn = document.getElementById("questSubmitBtn");

const proofModal = document.getElementById("proofModal");
const closeProofModal = document.getElementById("closeProofModal");
const proofForm = document.getElementById("proofForm");
const proofQuestTitle = document.getElementById("proofQuestTitle");
const proofText = document.getElementById("proofText");
const proofStatus = document.getElementById("proofStatus");
const proofSubmitBtn = document.getElementById("proofSubmitBtn");

const toastEl = document.getElementById("toast");

// --- Private quests: tabs, panel, modal ---
const tabPublicBtn = document.getElementById("tabPublicBtn");
const tabPrivateBtn = document.getElementById("tabPrivateBtn");
const publicPanel = document.getElementById("publicPanel");
const privatePanel = document.getElementById("privatePanel");

const newPrivateQuestBtn = document.getElementById("newPrivateQuestBtn");
const privateQuestModal = document.getElementById("privateQuestModal");
const closePrivateQuestModal = document.getElementById("closePrivateQuestModal");
const privateQuestForm = document.getElementById("privateQuestForm");
const privateQuestList = document.getElementById("privateQuestList");
const privateEmptyState = document.getElementById("privateEmptyState");
const privatePointsEl = document.getElementById("privatePoints");

// ---------------------------------------------------------
// UTIL
// ---------------------------------------------------------

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => (toastEl.hidden = true), 3200);
}

function levelForPoints(points) {
  const level = Math.floor(points / 100) + 1;
  const progress = points % 100;
  return { level, progress };
}

function initials(name) {
  return (name || "?")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

// Majority of everyone besides the poster, based on the guild's current
// size. Always at least 1 unless the poster is literally alone in the
// guild (nobody else to ask, so a solo quest can just go live).
function requiredApprovalsFor(posterUid) {
  const others = users.filter((u) => u.id !== posterUid).length;
  if (others <= 0) return 0;
  return Math.max(1, Math.ceil(others / 2));
}

// A quest is past due once QUEST_LIFETIME_DAYS have elapsed since it was
// posted. Quests created before this feature existed have no dueAt and
// are treated as never expiring.
function isExpired(q) {
  if (!q.dueAt) return false;
  const due = q.dueAt.toDate ? q.dueAt.toDate() : new Date(q.dueAt);
  return due.getTime() < Date.now();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------
// AUTH / LOGIN
// ---------------------------------------------------------

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  if (!name) return;
  loginError.hidden = true;

  try {
    const cred = await auth.signInAnonymously();
    const uid = cred.user.uid;

    await db.collection("users").doc(uid).set(
      {
        name,
        points: 0,
        tasksCompleted: 0,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    localStorage.setItem("questboard_name", name);
    enterApp(uid, name);
  } catch (err) {
    console.error(err);
    loginError.textContent =
      "Couldn't connect — check that config.js has a valid Firebase config.";
    loginError.hidden = false;
  }
});

auth.onAuthStateChanged((user) => {
  if (user) {
    const savedName = localStorage.getItem("questboard_name");
    if (savedName) {
      db.collection("users")
        .doc(user.uid)
        .get()
        .then((doc) => {
          const name = doc.exists ? doc.data().name : savedName;
          enterApp(user.uid, name);
        });
    }
  }
});

function enterApp(uid, name) {
  currentUser = { uid, name };
  loginScreen.hidden = true;
  appScreen.hidden = false;
  meName.textContent = name;
  listenToQuests();
  listenToUsers();
  listenToPrivateQuests();
  listenToPrivateProfile();
}

// ---------------------------------------------------------
// TABS: Guild Board <-> My Private Quests
// ---------------------------------------------------------

tabPublicBtn.addEventListener("click", () => switchTab("public"));
tabPrivateBtn.addEventListener("click", () => switchTab("private"));

function switchTab(tab) {
  const isPublic = tab === "public";
  publicPanel.hidden = !isPublic;
  privatePanel.hidden = isPublic;
  tabPublicBtn.classList.toggle("tab-btn--active", isPublic);
  tabPrivateBtn.classList.toggle("tab-btn--active", !isPublic);
}

// ---------------------------------------------------------
// REAL-TIME LISTENERS
// ---------------------------------------------------------

function listenToQuests() {
  db.collection("quests")
    .orderBy("createdAt", "desc")
    .onSnapshot(
      (snap) => {
        quests = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        renderQuests();
      },
      (err) => console.error("quests listener:", err)
    );
}

function listenToUsers() {
  db.collection("users")
    .orderBy("points", "desc")
    .onSnapshot(
      (snap) => {
        users = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        renderLeaderboard();
        renderMe();
      },
      (err) => console.error("users listener:", err)
    );
}

// Query is scoped to ownerId == currentUser.uid — this isn't just a nicety,
// it's required for the Firestore rules below to allow the query at all,
// since rules can't filter a list() after the fact, only permit/deny it
// based on how it's already constrained.
function listenToPrivateQuests() {
  db.collection("privateQuests")
    .where("ownerId", "==", currentUser.uid)
    .orderBy("createdAt", "desc")
    .onSnapshot(
      (snap) => {
        privateQuests = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        renderPrivateQuests();
      },
      (err) => console.error("private quests listener:", err)
    );
}

// Private points live on a totally separate doc/collection from the public
// `users` doc (which anyone can read for the leaderboard) — so there's no
// way for another guild member to see this even by querying Firestore
// directly, not just "hidden in the UI".
function listenToPrivateProfile() {
  db.collection("privateProfiles")
    .doc(currentUser.uid)
    .onSnapshot(
      (doc) => {
        const pts = doc.exists ? doc.data().privatePoints || 0 : 0;
        if (privatePointsEl) privatePointsEl.textContent = `🔒 ${pts} private pts`;
      },
      (err) => console.error("private profile listener:", err)
    );
}

// ---------------------------------------------------------
// RENDER: TOP BAR (me)
// ---------------------------------------------------------

function renderMe() {
  const me = users.find((u) => u.id === currentUser.uid);
  const points = me ? me.points : 0;
  const { level, progress } = levelForPoints(points);
  meLevel.textContent = `Lv. ${level}`;
  mePoints.textContent = `${points} pts`;
  meXpFill.style.width = `${progress}%`;
}

// ---------------------------------------------------------
// RENDER: LEADERBOARD
// ---------------------------------------------------------

function renderLeaderboard() {
  leaderboardEl.innerHTML = "";
  users.forEach((u, i) => {
    const { level } = levelForPoints(u.points || 0);
    const li = document.createElement("li");
    li.className = "leaderboard__item";
    li.innerHTML = `
      <span class="leaderboard__rank">#${i + 1}</span>
      <span class="leaderboard__avatar">${initials(u.name)}</span>
      <span class="leaderboard__info">
        <div class="leaderboard__name">${escapeHtml(u.name)}</div>
        <div class="leaderboard__level">Lv. ${level} · ${u.tasksCompleted || 0} done</div>
      </span>
      <span class="leaderboard__pts">${u.points || 0}</span>
    `;
    leaderboardEl.appendChild(li);
  });
}

// ---------------------------------------------------------
// RENDER: PRIVATE QUESTS
// ---------------------------------------------------------

function renderPrivateQuests() {
  privateQuestList.innerHTML = "";
  privateEmptyState.hidden = privateQuests.length > 0;

  privateQuests.forEach((q, i) => {
    const card = document.createElement("div");
    card.className = "quest-card quest-card--private";
    card.style.setProperty("--tilt", `${(i % 5) - 2}deg`);

    const done = q.status === "done";
    const footer = done
      ? `<span class="quest-card__by">✓ Completed · +${q.basePoints} private pts</span>`
      : `<button class="btn btn--primary" data-action="private-done" data-id="${q.id}">Mark done</button>`;

    card.innerHTML = `
      <span class="quest-card__status quest-card__status--${done ? "done" : "pending"}">🔒 ${done ? "Completed" : "Private"}</span>
      <div class="quest-card__subject">${escapeHtml(q.subject || "General")}</div>
      <h4 class="quest-card__title">${escapeHtml(q.title)}</h4>
      ${q.notes ? `<p class="quest-card__notes">${escapeHtml(q.notes)}</p>` : ""}
      <div class="quest-card__meta"><span>⚡ ${q.basePoints} pts</span></div>
      <div class="quest-card__footer">${footer}</div>
    `;
    privateQuestList.appendChild(card);
  });
}

privateQuestList.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action='private-done']");
  if (!btn) return;
  completePrivateQuest(btn.dataset.id);
});

async function completePrivateQuest(id) {
  const ref = db.collection("privateQuests").doc(id);
  const profileRef = db.collection("privateProfiles").doc(currentUser.uid);
  try {
    await db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists || doc.data().status !== "open") {
        throw new Error("This one's already marked done.");
      }
      const data = doc.data();
      tx.update(ref, {
        status: "done",
        completedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      tx.set(
        profileRef,
        {
          privatePoints: firebase.firestore.FieldValue.increment(data.basePoints),
          privateTasksCompleted: firebase.firestore.FieldValue.increment(1),
        },
        { merge: true }
      );
    });
    showToast("Marked done — private points added.");
  } catch (err) {
    showToast(err.message || "Couldn't mark that done.");
  }
}

newPrivateQuestBtn.addEventListener("click", () => (privateQuestModal.hidden = false));
closePrivateQuestModal.addEventListener("click", () => (privateQuestModal.hidden = true));
privateQuestModal.addEventListener("click", (e) => {
  if (e.target === privateQuestModal) privateQuestModal.hidden = true;
});

// No Gemini calls here at all — private quests are a personal list only
// the owner ever sees, so there's nobody to protect from a gibberish or
// easy quest, and nothing here ever touches the public leaderboard.
privateQuestForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = document.getElementById("pqTitle").value.trim();
  const subject = document.getElementById("pqSubject").value.trim();
  const notes = document.getElementById("pqNotes").value.trim();
  const basePoints = clamp(
    parseInt(document.getElementById("pqPoints").value, 10) || 0,
    5,
    MAX_BASE_POINTS
  );
  if (!title) return;

  await db.collection("privateQuests").add({
    title,
    subject,
    notes,
    basePoints,
    status: "open",
    ownerId: currentUser.uid,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  });

  privateQuestForm.reset();
  document.getElementById("pqPoints").value = 20;
  privateQuestModal.hidden = true;
  showToast("Private quest created.");
});

// ---------------------------------------------------------
// RENDER: QUEST BOARD
// ---------------------------------------------------------

function renderQuests() {
  questList.innerHTML = "";

  // Rejected quests stay in Firestore for the record but never render.
  // Past-due quests drop off the board too — unless the current viewer
  // still has an unfinished claim on it, so they don't lose in-progress
  // work just because the clock ran out on the listing itself.
  const visibleQuests = quests.filter((q) => {
    if (q.status === "rejected") return false;
    if (isExpired(q)) {
      const myClaim = (q.claims || {})[currentUser.uid];
      return !!myClaim && myClaim.status === "in_progress";
    }
    return true;
  });
  emptyState.hidden = visibleQuests.length > 0;

  const pendingForMe = visibleQuests.filter(
    (q) =>
      q.status === "pending_approval" &&
      q.createdById !== currentUser.uid &&
      !(q.approvals || []).includes(currentUser.uid) &&
      !(q.rejections || []).includes(currentUser.uid)
  );
  if (pendingForMe.length > 0) {
    pendingBanner.hidden = false;
    pendingBanner.textContent = `🔔 ${pendingForMe.length} quest${
      pendingForMe.length > 1 ? "s need" : " needs"
    } your approval before it can go live.`;
  } else {
    pendingBanner.hidden = true;
  }

  visibleQuests.forEach((q, i) => {
    const card = document.createElement("div");
    card.className = "quest-card";
    card.style.setProperty("--tilt", `${(i % 5) - 2}deg`);

    const expired = isExpired(q);
    const statusMap = {
      pending_approval: { cls: "pending", label: "Needs Approval" },
      open: { cls: expired ? "expired" : "open", label: expired ? "Past Due" : "Open" },
    };
    const { cls: statusClass, label: statusLabel } = statusMap[q.status] || statusMap.open;

    let footer = "";

    if (q.status === "pending_approval") {
      const approvals = q.approvals || [];
      const rejections = q.rejections || [];
      const iVoted = approvals.includes(currentUser.uid) || rejections.includes(currentUser.uid);

      if (q.createdById === currentUser.uid) {
        footer = `<span class="quest-card__by">Awaiting approval — ${approvals.length}/${q.requiredApprovals} approved</span>`;
      } else if (iVoted) {
        const mine = approvals.includes(currentUser.uid) ? "You approved this" : "You flagged this";
        footer = `<span class="quest-card__by">${mine} — ${approvals.length}/${q.requiredApprovals} approved</span>`;
      } else {
        footer = `
          <button class="btn btn--accent" data-action="approve" data-id="${q.id}">Approve</button>
          <button class="btn btn--danger" data-action="reject" data-id="${q.id}">Flag</button>
        `;
      }
    } else if (q.status === "open") {
      const claims = q.claims || {};
      const completedByUids = q.completedByUids || [];
      const myClaim = claims[currentUser.uid];

      // One row per person who's claimed this quest — everyone can see
      // who's working it and who's finished, since it's no longer
      // exclusive to a single claimant.
      const rows = Object.entries(claims)
        .map(([uid, c]) => {
          if (c.status === "done") {
            const mine = uid === currentUser.uid;
            return `<div class="quest-card__claim">
              <span>✓ ${escapeHtml(c.name)} · +${c.earnedPoints ?? 0} pts</span>
              ${
                mine
                  ? `<button class="btn btn--small" data-action="remove-claim" data-id="${q.id}">Remove</button>`
                  : ""
              }
            </div>`;
          }
          return `<div class="quest-card__claim">
            <span>⏳ ${escapeHtml(c.name)} — in progress</span>
          </div>`;
        })
        .join("");

      let actionRow = "";
      if (myClaim && myClaim.status === "in_progress") {
        actionRow = `<button class="btn btn--accent" data-action="turnin" data-id="${q.id}">Turn in work</button>`;
      } else if (!myClaim && !completedByUids.includes(currentUser.uid) && !expired) {
        actionRow = `<button class="btn btn--primary" data-action="claim" data-id="${q.id}">Claim quest</button>`;
      } else if (!myClaim && expired) {
        actionRow = `<span class="quest-card__by">Past due — no longer claimable</span>`;
      }

      footer = `${rows}${actionRow}`;
    }

    card.innerHTML = `
      <span class="quest-card__status quest-card__status--${statusClass}">${statusLabel}</span>
      <div class="quest-card__subject">${escapeHtml(q.subject || "General")}</div>
      <h4 class="quest-card__title">${escapeHtml(q.title)}</h4>
      ${q.notes ? `<p class="quest-card__notes">${escapeHtml(q.notes)}</p>` : ""}
      <div class="quest-card__meta">
        <span>⚡ ${q.basePoints} base pts</span>
        <span>⏱ ~${q.estimateMinutes} min</span>
      </div>
      <div class="quest-card__footer">${footer}</div>
      <div class="quest-card__by">Posted by ${escapeHtml(q.createdByName || "—")}</div>
    `;
    questList.appendChild(card);
  });
}

// ---------------------------------------------------------
// QUEST BOARD ACTIONS (event delegation)
// ---------------------------------------------------------

questList.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const id = btn.dataset.id;
  const action = btn.dataset.action;

  if (action === "claim") claimQuest(id);
  if (action === "turnin") openProofModal(id);
  if (action === "approve") voteOnQuest(id, "approve");
  if (action === "reject") voteOnQuest(id, "reject");
  if (action === "remove-claim") removeClaim(id);
});

async function voteOnQuest(id, vote) {
  const ref = db.collection("quests").doc(id);
  try {
    await db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists || doc.data().status !== "pending_approval") {
        throw new Error("This quest isn't awaiting approval anymore.");
      }
      const data = doc.data();
      if (data.createdById === currentUser.uid) {
        throw new Error("You can't approve your own quest.");
      }
      const approvals = data.approvals || [];
      const rejections = data.rejections || [];
      if (approvals.includes(currentUser.uid) || rejections.includes(currentUser.uid)) {
        throw new Error("You already voted on this quest.");
      }

      // Fallback for any quest posted before this field existed.
      const required = data.requiredApprovals ?? 2;

      const newApprovals = vote === "approve" ? [...approvals, currentUser.uid] : approvals;
      const newRejections = vote === "reject" ? [...rejections, currentUser.uid] : rejections;

      let newStatus = "pending_approval";
      if (newApprovals.length >= required) newStatus = "open";
      else if (newRejections.length >= required) newStatus = "rejected";

      tx.update(ref, { approvals: newApprovals, rejections: newRejections, status: newStatus });
    });
    showToast(vote === "approve" ? "Approved." : "Flagged.");
  } catch (err) {
    showToast(err.message || "Couldn't record your vote.");
  }
}

// Claiming no longer locks a quest to one person — any number of guild
// members can claim the same quest and work it independently. Each
// person just gets their own entry in the quest's `claims` map, with
// their own clock and their own eventual points.
async function claimQuest(id) {
  const ref = db.collection("quests").doc(id);
  try {
    await db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists || doc.data().status !== "open") {
        throw new Error("This quest isn't open to claim.");
      }
      const data = doc.data();
      if (isExpired(data)) {
        throw new Error("This quest is past due.");
      }
      const claims = data.claims || {};
      const completedByUids = data.completedByUids || [];
      if (claims[currentUser.uid]) {
        throw new Error("You've already claimed this quest.");
      }
      if (completedByUids.includes(currentUser.uid)) {
        throw new Error("You've already completed this quest.");
      }
      tx.update(ref, {
        [`claims.${currentUser.uid}`]: {
          name: currentUser.name,
          status: "in_progress",
          startedAt: firebase.firestore.FieldValue.serverTimestamp(),
        },
      });
    });
    showToast("Quest claimed — good luck!");
  } catch (err) {
    showToast(err.message || "Couldn't claim that quest.");
  }
}

// Lets someone clear their own completed claim off a quest card once
// they're done looking at it. Only ever touches the caller's own entry —
// it never affects the quest itself or anyone else's claim on it. Their
// uid stays in completedByUids so they can't just re-claim for more points.
async function removeClaim(id) {
  const ref = db.collection("quests").doc(id);
  try {
    await ref.update({
      [`claims.${currentUser.uid}`]: firebase.firestore.FieldValue.delete(),
    });
    showToast("Removed.");
  } catch (err) {
    console.error(err);
    showToast("Couldn't remove that.");
  }
}

// ---------------------------------------------------------
// NEW QUEST MODAL
// ---------------------------------------------------------

newQuestBtn.addEventListener("click", () => {
  qStatus.hidden = true;
  questModal.hidden = false;
});
closeQuestModal.addEventListener("click", () => (questModal.hidden = true));
questModal.addEventListener("click", (e) => {
  if (e.target === questModal) questModal.hidden = true;
});

questForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = document.getElementById("qTitle").value.trim();
  const subject = document.getElementById("qSubject").value.trim();
  const notes = document.getElementById("qNotes").value.trim();
  const estimateMinutes = parseInt(document.getElementById("qEstimate").value, 10);
  const basePoints = clamp(
    parseInt(document.getElementById("qPoints").value, 10) || 0,
    5,
    MAX_BASE_POINTS
  );
  if (!title) return;

  setQuestStatus("pending", "Checking this is a real task with Gemini…");
  questSubmitBtn.disabled = true;

  try {
    const review = await reviewQuestWithGemini(title, subject, notes);
    if (!review.legitimate) {
      setQuestStatus(
        "fail",
        `Rejected: ${review.reason || "This doesn't look like a real task."}`
      );
      questSubmitBtn.disabled = false;
      return;
    }

    const required = requiredApprovalsFor(currentUser.uid);
    const initialStatus = required === 0 ? "open" : "pending_approval";
    const dueAt = firebase.firestore.Timestamp.fromDate(
      new Date(Date.now() + QUEST_LIFETIME_DAYS * 24 * 60 * 60 * 1000)
    );

    await db.collection("quests").add({
      title,
      subject,
      basePoints,
      estimateMinutes,
      notes,
      status: initialStatus,
      requiredApprovals: required,
      approvals: [],
      rejections: [],
      claims: {},
      completedByUids: [],
      dueAt,
      createdById: currentUser.uid,
      createdByName: currentUser.name,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });

    questForm.reset();
    document.getElementById("qPoints").value = 20;
    document.getElementById("qEstimate").value = 30;
    questSubmitBtn.disabled = false;
    questModal.hidden = true;
    showToast(
      required === 0
        ? "Quest posted — you're the only one in the guild, so it's live."
        : `Quest sent for approval — needs ${required} guild member${required > 1 ? "s" : ""} to go live.`
    );
  } catch (err) {
    console.error(err);
    setQuestStatus(
      "fail",
      "Couldn't reach the review service. Not posted — try again."
    );
    questSubmitBtn.disabled = false;
  }
});

function setQuestStatus(kind, msg) {
  qStatus.hidden = false;
  qStatus.className = `proof-status proof-status--${kind}`;
  qStatus.textContent = msg;
}

// ---------------------------------------------------------
// TURN-IN / PROOF MODAL + GEMINI VERIFICATION
// ---------------------------------------------------------

function openProofModal(id) {
  activeProofQuestId = id;
  const q = quests.find((x) => x.id === id);
  proofQuestTitle.textContent = q ? `"${q.title}"` : "";
  proofText.value = "";
  proofStatus.hidden = true;
  proofModal.hidden = false;
}

closeProofModal.addEventListener("click", () => (proofModal.hidden = true));
proofModal.addEventListener("click", (e) => {
  if (e.target === proofModal) proofModal.hidden = true;
});

proofForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = quests.find((x) => x.id === activeProofQuestId);
  if (!q) return;

  const description = proofText.value.trim();
  if (!description) return;

  const wordCount = description.split(/\s+/).filter(Boolean).length;
  if (wordCount < 12) {
    setProofStatus(
      "fail",
      "Too short to verify — describe specifically what you did (at least a sentence or two, not just \"done\" or \"completed it\")."
    );
    return;
  }

  setProofStatus("pending", "Checking your work with Gemini…");
  proofSubmitBtn.disabled = true;

  try {
    const result = await verifyWithGemini(q, description);

    if (!result.completed) {
      setProofStatus(
        "fail",
        `Not verified: ${result.reason || "This doesn't look like a completed quest yet."}`
      );
      proofSubmitBtn.disabled = false;
      return;
    }

    await completeQuest(q, description);
    setProofStatus("success", "Verified! Points awarded.");
    setTimeout(() => {
      proofModal.hidden = true;
      proofSubmitBtn.disabled = false;
    }, 900);
  } catch (err) {
    console.error(err);
    setProofStatus(
      "fail",
      "Couldn't reach the review service. Not marked complete — try again."
    );
    proofSubmitBtn.disabled = false;
  }
});

function setProofStatus(kind, msg) {
  proofStatus.hidden = false;
  proofStatus.className = `proof-status proof-status--${kind}`;
  proofStatus.textContent = msg;
}

// Calls the Cloudflare Worker, which holds the Gemini API key server-side
// and forwards the prompt on to Gemini. The key never reaches the browser.
async function verifyWithGemini(quest, description) {
  const prompt = `You are a skeptical reviewer checking whether a student plausibly completed a study task. You are NOT grading correctness or quality — you ARE checking that the description contains real, specific evidence of doing the work, not just a claim that it's done.

REJECT (completed: false) if the description:
- Is a generic completion claim with no specifics, e.g. "I did it", "I completed my work", "finished the task", "all done", even if grammatically fine and on-topic in wording.
- Is blank, gibberish, or nonsense.
- Is off-topic / unrelated to the task title, subject, or notes.
- Just restates the task title/notes back without describing any actual action taken or content produced.

ACCEPT (completed: true) only if the description names concrete specifics tied to the task — e.g. particular problems/steps/topics covered, what was read or written, what approach was used, what the result was, a number of items done, or similar tangible detail a person could only know by actually having done the work.

Task title: ${quest.title}
Subject: ${quest.subject || "n/a"}
Task notes: ${quest.notes || "n/a"}

Student's description of what they did:
"""${description}"""

Example of REJECT: "I have completed my work." → {"completed": false, "reason": "Generic claim with no specific details about the work done."}
Example of ACCEPT: "Solved problems 1-10, mostly linear equations, checked answers against the textbook." → {"completed": true, "reason": "Names specific problems and method used."}

Respond with ONLY a JSON object, no markdown fences, in this exact shape:
{"completed": true or false, "reason": "one short sentence"}`;

  const text = await callGemini(prompt, 150);
  const cleaned = text.replace(/```json|```/g, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // Fall back to a conservative "not verified" if parsing fails
    return { completed: false, reason: "Couldn't parse verification result." };
  }
}

// Checked once when a quest is posted, before it's even shown to the
// guild for approval — catches gibberish/joke tasks at the source.
async function reviewQuestWithGemini(title, subject, notes) {
  const prompt = `You are checking whether a submitted study/homework task is a real, coherent task — not gibberish, a joke, or something trivially degenerate designed purely to farm points (e.g. "type the letter a", "click this quest").

REJECT (legitimate: false) if the title or notes are nonsense, keyboard mashing, a joke, or describe an action so trivial/degenerate it isn't a genuine piece of study work.
ACCEPT (legitimate: true) if it's a plausible, coherent study or homework task, even if brief — it does not need to be impressive or detailed, just real.

Title: ${title}
Subject: ${subject || "n/a"}
Notes: ${notes || "n/a"}

Example REJECT: "asdkjf" / "click here for points" / "blink twice"
Example ACCEPT: "Read chapter 5" / "Finish algebra worksheet" / "Review flashcards for bio quiz"

Respond with ONLY a JSON object, no markdown fences:
{"legitimate": true or false, "reason": "one short sentence"}`;

  const text = await callGemini(prompt, 100);
  const cleaned = text.replace(/```json|```/g, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // Conservative fallback: if we can't parse the verdict, don't post it.
    return { legitimate: false, reason: "Couldn't parse review result." };
  }
}

async function callGemini(prompt, maxOutputTokens) {
  const res = await fetch("https://study-guild.pratap-ram-varma.workers.dev", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, maxOutputTokens }),
  });
  if (!res.ok) throw new Error(`Worker request failed (${res.status})`);
  const data = await res.json();
  return data.text || "";
}

// Each claimant is scored off their own claim's startedAt, not a single
// quest-level timestamp — so two people working the same quest at
// different speeds each get points based on their own time taken.
async function completeQuest(quest, proof) {
  const ref = db.collection("quests").doc(quest.id);
  const userRef = db.collection("users").doc(currentUser.uid);

  await db.runTransaction(async (tx) => {
    const questDoc = await tx.get(ref);
    if (!questDoc.exists) {
      throw new Error("Quest no longer exists.");
    }
    const data = questDoc.data();
    const myClaim = (data.claims || {})[currentUser.uid];
    if (!myClaim || myClaim.status !== "in_progress") {
      throw new Error("You don't have an in-progress claim on this quest.");
    }

    // Speed-based scoring: faster than estimate → bonus, slower → penalty,
    // clamped so nobody can zero out or blow up the reward.
    const startedAt = myClaim.startedAt ? myClaim.startedAt.toDate() : new Date();
    const elapsedMinutes = Math.max(1, (Date.now() - startedAt.getTime()) / 60000);
    const speedMultiplier = clamp(data.estimateMinutes / elapsedMinutes, 0.5, 2);
    const earnedPoints = Math.round(data.basePoints * speedMultiplier);

    tx.update(ref, {
      [`claims.${currentUser.uid}.status`]: "done",
      [`claims.${currentUser.uid}.proof`]: proof,
      [`claims.${currentUser.uid}.earnedPoints`]: earnedPoints,
      [`claims.${currentUser.uid}.completedAt`]: firebase.firestore.FieldValue.serverTimestamp(),
      completedByUids: firebase.firestore.FieldValue.arrayUnion(currentUser.uid),
    });

    tx.set(
      userRef,
      {
        points: firebase.firestore.FieldValue.increment(earnedPoints),
        tasksCompleted: firebase.firestore.FieldValue.increment(1),
      },
      { merge: true }
    );
  });
}
