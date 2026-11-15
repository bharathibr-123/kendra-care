# LinkedIn post (draft)

Edit freely so it sounds like you. Replace the two links before posting.

---

My grandmother's reminder app could tell her it was 8 AM. It couldn't tell anyone when she didn't respond.

For the PromptWars × Catalyst solo AI hackathon (Google for Developers × Hack2skill), the challenge was an elderly care and medication platform. I built **Kendra** (ಕೇಂದ್ರ, "centre" in Kannada): care that circles around the elder, with decisions that stay with them.

Most reminder apps stop at the notification. Kendra focuses on what happens after it:

🔁 **Care Continuity Engine.** If a dose isn't confirmed, Kendra sends the elder a follow-up, then alerts the primary caregiver, then the backup contact. When a caregiver acknowledges the alert, escalation stops. Every step is de-duplicated and shown on a timeline.

✅ **Honest statuses.** "Unconfirmed" is never shown as "missed". A dose is only recorded as missed when someone reports it.

📈 **Routine drift detection.** Plain statistics, not an LLM: the median and MAD of confirmation times against the elder's own 14-day baseline. It noticed that morning confirmations in the demo had drifted about 40 minutes later, and it says "not enough data" when that's true.

🤝 **Caregiver handover.** Each handover carries a live snapshot of what's confirmed, what's pending, open alerts, tomorrow's appointment and open tasks. The next caregiver acknowledges it.

🗣️ **A Care Companion in Kannada and English.** You can ask by voice: "ನಾನು ಇವತ್ತು ಬೆಳಿಗ್ಗೆ ಔಷಧಿ ತೆಗೆದುಕೊಂಡಿದ್ದೇನಾ?" It answers only from the elder's own records through a fixed tool layer, refuses dosage questions, and points emergencies to 112.

🧓 **The elder decides.** Family and caretakers propose changes, and the elder approves them. There's also an emergency card with an expiring QR link.

Under the hood: Node.js + Express, Gemini (for JSON-schema prescription reading, brief wording and intent fallback only), Cloud Firestore, Gmail reminders, Google Calendar and Maps links, and the Web Speech API. There are 93 automated tests, 0 axe-core accessibility violations, and a strict CSP. It's a hackathon prototype with fictional demo data, not a clinically validated product.

What I learned: the hard part of "AI for care" isn't the AI. It's deciding what the system must never pretend to know.

🔗 Live demo (one click, no sign-up): <DEPLOYED_URL>
💻 Code: <GITHUB_URL>

#PromptWars #BuildWithAI #GoogleForDevelopers #Hack2skill #Gemini #ElderCare #HealthTech #Accessibility #Kannada

---

*Note: the opening line is personal. Keep it only if it's true for you; otherwise start from the second paragraph.*
