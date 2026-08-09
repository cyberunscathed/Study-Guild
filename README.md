# QuestBoard

A shared study/homework board: post tasks ("quests"), claim one, do the work,
submit a short description of what you did, and Gemini checks it's a genuine
completion (not correctness-graded) before awarding points. Points scale with
speed — faster than your own time estimate earns a bonus, slower earns less.

Everyone who opens the page sees the same board update live, powered by
Firestore. No backend server — it's plain HTML/CSS/JS, deployable straight to
GitHub Pages.

## 1. Create a Firebase project (free)

1. Go to https://console.firebase.google.com → **Add project** → give it any name.
2. In the project, go to **Build → Firestore Database → Create database**.
   Pick "production mode" (rules below lock it down) and any nearby region.
3. Go to **Build → Authentication → Get started → Sign-in method → Anonymous → Enable**.
   This is how people join with just a name, no password.
4. Go to **Project settings (gear icon) → General → Your apps → Web (</> icon)**.
   Register an app (no hosting needed) and copy the `firebaseConfig` object.

## 2. Fill in `config.js`

Paste your Firebase config into `FIREBASE_CONFIG`, and put a Gemini API key
(from https://aistudio.google.com/app/apikey) into `GEMINI_API_KEY`.

Since keys stay visible in the page source on GitHub Pages:
- In Google AI Studio, set a daily quota / billing cap on the Gemini key so
  it can't be run up by someone else.
- In Firebase console → Firestore → **Rules**, use something like this so
  visitors can only write their own user doc and can't delete quests
  outright:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read: if true;
      allow write: if request.auth != null && request.auth.uid == userId;
    }
    match /quests/{questId} {
      allow read: if true;
      allow create: if request.auth != null;
      allow update: if request.auth != null;
      allow delete: if false;
    }
  }
}
```

This is intentionally simple for a demo — it doesn't stop a logged-in user
from editing someone else's quest doc. Tighten `allow update` further
(e.g. checking `resource.data.claimedById == request.auth.uid`) if this
stops being a demo.

## 3. Run it locally

No build step. Just serve the folder, e.g.:

```
cd questboard
python3 -m http.server 8000
```

Open http://localhost:8000

## 4. Publish to GitHub Pages

1. Push this folder to a GitHub repo.
2. Repo → **Settings → Pages → Source**: choose the branch and root folder.
3. Your site is live at `https://<username>.github.io/<repo>/`.

## Anti-farming safeguards

To stop someone posting an easy/nonsense quest and repeatedly completing it
for cheap points:

- **Base points are capped** at `MAX_BASE_POINTS` (50 by default, in `app.js`)
  — enforced in the form and again in code, so it can't be bypassed via
  dev tools.
- **Gemini reviews new quests at posting time** — gibberish, joke, or
  trivially degenerate tasks ("type the letter a") are rejected before
  they're ever shown to the guild.
- **Peer approval, scaled to guild size** — a new quest starts in a
  `pending_approval` state. The number of approvals needed is a majority
  of everyone *except* the poster (`Math.ceil(otherMembers / 2)`, minimum
  1), computed from the guild's size at the moment the quest is posted and
  stored on the quest itself — so it stays fixed even if the guild grows
  or shrinks while a vote is in progress. The poster can't approve their
  own quest. If the poster is the only person in the guild, there's no one
  to ask, so the quest goes live immediately instead of stalling forever.
  Enough flags (the same threshold) kills a bad quest instead of approving
  it. Since the board is real-time, everyone sees a quest needing approval
  the moment it's posted — a banner flags it.

For a 4-person guild this means 2 approvals; a 2-person guild needs 1; a
10-person guild needs 5 — so a pair of friends approving each other's easy
quests can't push something through alone once the guild is bigger than a
couple of people.

## How scoring works

- Each quest has a **base points** value and an **estimated time**, set by
  whoever posts it.
- When you claim a quest, the clock starts (`startedAt`).
- When you turn it in, `speedMultiplier = estimate / actualTime`, clamped
  between 0.5× and 2× — so a slow completion still earns something, and a
  suspiciously fast one can't infinitely inflate points.
- `earnedPoints = round(basePoints × speedMultiplier)`.
- Level is `floor(points / 100) + 1`; the XP bar shows progress to the next 100.

## What Gemini does (and doesn't do)

On turn-in, the description you write is sent to Gemini with the quest's
title/subject/notes, asking only: *is this a genuine, specific, on-topic
account of doing the work?* It rejects blank/gibberish/off-topic submissions
but does **not** grade correctness — that was intentionally left out per the
current scope. `GEMINI_MODEL` in `config.js` is set to a cheap, low-latency
model since this is the only place the app calls out to an LLM.

## Extending later

- Swap anonymous auth for Google sign-in if you want persistent identities
  across devices.
- Add a `subject` filter or due dates to the board.
- Turn on correctness grading by asking Gemini to compare the proof against
  an answer key stored on the quest doc.
