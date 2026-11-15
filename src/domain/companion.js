'use strict';

const { localParts, wallToMinutes, timeSlot } = require('./time');
const { scheduleForDate, DOSE_STATUS } = require('./schedule');

/**
 * Care Companion: a bilingual (English / ಕನ್ನಡ) assistant that answers ONLY from the
 * elder's stored records through a fixed set of tools. The language model (if any) may
 * help pick the intent, but never writes the facts: every answer is a template filled
 * with tool output, so it cannot invent medicines, doses or appointments.
 *
 * Pipeline: detect language → safety screen → classify intent → run tool → template.
 */

const INTENTS = Object.freeze(['emergency', 'medical_advice', 'confirmation', 'appointment', 'stock', 'contacts', 'medicines', 'help', 'unknown']);
const PERIODS = Object.freeze(['morning', 'afternoon', 'evening', 'night', 'today']);

const SAFETY = {
  emergency: [
    /\b(chest pain|heart attack|stroke|can'?t breathe|cannot breathe|breathless|unconscious|fainted|i fell|have fallen|bleeding|emergency|ambulance)\b/i,
    /ತುರ್ತು|ಎದೆ ನೋವು|ಉಸಿರಾಡಲು|ಉಸಿರಾಟ ಕಷ್ಟ|ಪ್ರಜ್ಞೆ|ಬಿದ್ದೆ|ಬಿದ್ದಿದ್ದೇನೆ|ಆಂಬ್ಯುಲೆನ್ಸ್|ರಕ್ತಸ್ರಾವ/,
  ],
  medicalAdvice: [
    /\b(stop|quit|double|increase|decrease|reduce|change|adjust|skip)\s+(taking\s+)?(my\s+|the\s+|this\s+)?(dose|dosage|medicine|medication|tablets?|pills?)\b/i,
    /\b(can|should|may)\s+i\s+(stop|skip|double|increase|reduce|decrease|change|replace|take (an? )?(extra|another|more))\b/i,
    /\b(extra|double)\s+(dose|tablet|pill)\b|\bprescribe\b|\bsubstitute\b|\bside effects?\b|\bis it safe\b|\boverdose\b/i,
    /ನಿಲ್ಲಿಸ|ಡೋಸ್ ಹೆಚ್ಚಿಸ|ಹೆಚ್ಚು ಡೋಸ್|ಕಡಿಮೆ ಮಾಡ|ಬದಲಾಯಿಸ|ಅಡ್ಡ ಪರಿಣಾಮ|ಎರಡು ಮಾತ್ರೆ/,
  ],
};

const INTENT_PATTERNS = [
  ['confirmation', [/\b(did i|have i|had i)\b.*\b(take|taken|took|confirm|confirmed|had)\b/i, /\b(confirmed|already taken|marked)\b/i, /ತೆಗೆದುಕೊಂಡಿದ್ದೇನಾ|ತೆಗೆದುಕೊಂಡೆನಾ|ತೆಗೆದುಕೊಂಡಿದ್ದೀನಾ|ತಗೊಂಡಿದ್ದೀನಾ|ದೃಢ/]],
  ['appointment', [/\b(appointment|doctor|checkup|check-up|consultation|hospital visit)\b/i, /ಅಪಾಯಿಂಟ್ಮೆಂಟ್|ಡಾಕ್ಟರ್|ವೈದ್ಯ|ಆಸ್ಪತ್ರೆ/]],
  ['stock', [/\b(refill|stock|running (low|out)|how many .* left|left in)\b/i, /ಉಳಿದಿದೆ|ಮುಗಿಯ|ಸ್ಟಾಕ್|ಖಾಲಿ/]],
  ['contacts', [/\b(who (should|do|can) i call|my contacts?|my caregiver|my nurse|phone number)\b/i, /ಯಾರಿಗೆ ಕರೆ|ಸಂಪರ್ಕ|ಫೋನ್ ನಂಬರ್/]],
  ['medicines', [/\b(medicine|medication|tablet|pill|dose|schedule)s?\b/i, /ಔಷಧ|ಮಾತ್ರೆ|ಗುಳಿಗೆ|ವೇಳಾಪಟ್ಟಿ/]],
  ['help', [/^\s*(hi|hello|hey|namaste|namaskara|help|what can you do)\b/i, /ನಮಸ್ಕಾರ|ಸಹಾಯ/]],
];

const PERIOD_PATTERNS = [
  ['morning', /\bmorning\b|ಬೆಳಿಗ್ಗೆ|ಬೆಳಗ್ಗೆ|ಬೆಳಗಿನ/i],
  ['afternoon', /\bafternoon\b|ಮಧ್ಯಾಹ್ನ/i],
  ['evening', /\bevening\b|ಸಂಜೆ/i],
  ['night', /\bnight\b|\bbedtime\b|ರಾತ್ರಿ/i],
  ['today', /\btoday\b|ಇಂದು|ಇವತ್ತು/i],
];

function detectLanguage(text) {
  return /[ಀ-೿]/.test(text) ? 'kn' : 'en';
}

function screen(text) {
  if (SAFETY.emergency.some((re) => re.test(text))) return 'emergency';
  if (SAFETY.medicalAdvice.some((re) => re.test(text))) return 'medical_advice';
  return null;
}

/** Rule-based intent and period. Returns intent "unknown" when nothing matches. */
function classify(text) {
  const safety = screen(text);
  const period = PERIOD_PATTERNS.find(([, re]) => re.test(text))?.[0] ?? null;
  if (safety) return { intent: safety, period };
  const intent = INTENT_PATTERNS.find(([, patterns]) => patterns.some((re) => re.test(text)))?.[0] ?? 'unknown';
  return { intent, period };
}

// ---------- tools: read-only views over the elder's records ----------

function tools(circle, now) {
  const local = localParts(now, circle.timezone);
  const today = scheduleForDate(circle, local.date, now);
  const inPeriod = (period) => (period && period !== 'today' ? today.filter((d) => timeSlot(d.time) === period) : today);
  return {
    medicines: (period) => {
      const doses = inPeriod(period);
      if (period) return { doses, period };
      const open = today.filter((d) => d.status === DOSE_STATUS.DUE || d.status === DOSE_STATUS.UNCONFIRMED);
      const upcoming = today.filter((d) => d.status === DOSE_STATUS.UPCOMING);
      const nextTime = upcoming[0]?.time;
      return { open, next: nextTime ? upcoming.filter((d) => d.time === nextTime) : [] };
    },
    confirmation: (period) => ({ doses: inPeriod(period || 'today'), period: period || 'today' }),
    appointment: () => ({
      next: circle.appointments
        .filter((a) => a.status === 'upcoming' && wallToMinutes(a.date, a.time) > local.minutes)
        .sort((a, b) => wallToMinutes(a.date, a.time) - wallToMinutes(b.date, b.time))[0] || null,
    }),
    stock: () => ({ low: circle.medications.filter((m) => m.active !== false && m.stock != null && m.refillAt != null && m.stock <= m.refillAt) }),
    contacts: () => ({
      contacts: circle.emergency?.contacts?.length
        ? circle.emergency.contacts
        : circle.members.filter((m) => m.role !== 'elder').map((m) => ({ name: m.name, relation: m.role, phone: '' })),
    }),
  };
}

// ---------- templates ----------

const KN_PERIOD = { morning: 'ಬೆಳಿಗ್ಗೆ', afternoon: 'ಮಧ್ಯಾಹ್ನ', evening: 'ಸಂಜೆ', night: 'ರಾತ್ರಿ', today: 'ಇಂದಿನ' };
const KN_STATUS = { taken: 'ದೃಢಪಟ್ಟಿದೆ', missed: 'ತಪ್ಪಿದೆ ಎಂದು ವರದಿಯಾಗಿದೆ', unconfirmed: 'ದೃಢೀಕರಣ ಬಾಕಿ', due: 'ಈಗ ತೆಗೆದುಕೊಳ್ಳುವ ಸಮಯ', upcoming: 'ಮುಂದೆ' };
const EN_STATUS = { taken: 'confirmed', missed: 'reported missed', unconfirmed: 'awaiting confirmation', due: 'due now', upcoming: 'later' };

function clock12(time) {
  const [h, m] = time.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function clockKn(time) {
  const [h, m] = time.split(':').map(Number);
  return `${KN_PERIOD[timeSlot(time)]} ${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}`;
}

function formatDate(date, lang) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(lang === 'kn' ? 'kn-IN' : 'en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
}

const doseLabel = (d) => `${d.name}${d.dosage ? ` ${d.dosage}` : ''}`;
const names = (doses) => doses.map(doseLabel).join(', ');

const RESPOND = {
  emergency: (lang, { contacts }) => {
    const first = contacts[0];
    const contact = first ? `${first.name}${first.phone ? ` (${first.phone})` : ''}` : '';
    return lang === 'kn'
      ? `ಇದು ತುರ್ತು ಪರಿಸ್ಥಿತಿಯಾಗಿದ್ದರೆ, ತಕ್ಷಣ 112 ಗೆ ಕರೆ ಮಾಡಿ.${contact ? ` ನಿಮ್ಮ ತುರ್ತು ಸಂಪರ್ಕ: ${contact}.` : ''} ರೋಗಲಕ್ಷಣಗಳನ್ನು ನಾನು ಪರಿಶೀಲಿಸಲಾರೆ.`
      : `If this is an emergency, call 112 now.${contact ? ` Your emergency contact is ${contact}.` : ''} I can't assess symptoms.`;
  },
  medical_advice: (lang) =>
    lang === 'kn'
      ? 'ಯಾವುದೇ ಔಷಧಿಯನ್ನು ಪ್ರಾರಂಭಿಸುವ, ನಿಲ್ಲಿಸುವ ಅಥವಾ ಡೋಸ್ ಬದಲಾಯಿಸುವ ಬಗ್ಗೆ ನಾನು ಸಲಹೆ ನೀಡಲಾರೆ. ದಯವಿಟ್ಟು ನಿಮ್ಮ ವೈದ್ಯರನ್ನು ಕೇಳಿ. ನಿಮ್ಮ ವೇಳಾಪಟ್ಟಿಯಲ್ಲಿ ಏನಿದೆ ಎಂದು ನಾನು ಹೇಳಬಲ್ಲೆ.'
      : "I can't advise on starting, stopping or changing any medicine or dose. Please ask your doctor. I can tell you what is on your schedule.",
  medicines: (lang, data) => {
    if (data.period) {
      if (data.doses.length === 0) {
        return lang === 'kn' ? `ಇಂದು ${KN_PERIOD[data.period]} ಯಾವುದೇ ಔಷಧಿ ನಿಗದಿಯಾಗಿಲ್ಲ.` : `You have no ${data.period === 'today' ? '' : `${data.period} `}medicine scheduled today.`.replace('  ', ' ');
      }
      const items = data.doses.map((d) =>
        lang === 'kn'
          ? `${doseLabel(d)}, ${clockKn(d.time)}${d.instructions ? ` (${d.instructions})` : ''} — ${KN_STATUS[d.status]}`
          : `${doseLabel(d)} at ${clock12(d.time)}${d.instructions ? `, ${d.instructions.toLowerCase()}` : ''} (${EN_STATUS[d.status]})`,
      );
      return lang === 'kn' ? `ನಿಮ್ಮ ${KN_PERIOD[data.period]} ಔಷಧಿಗಳು: ${items.join('; ')}.` : `Your ${data.period === 'today' ? "today's" : data.period} medicines: ${items.join('; ')}.`;
    }
    if (data.open.length > 0) {
      return lang === 'kn' ? `ಈಗ ತೆಗೆದುಕೊಳ್ಳಬೇಕಾದದ್ದು (ದೃಢೀಕರಣ ಬಾಕಿ): ${names(data.open)}.` : `Waiting for confirmation now: ${names(data.open)}.`;
    }
    if (data.next.length > 0) {
      const t = data.next[0].time;
      return lang === 'kn' ? `ನಿಮ್ಮ ಮುಂದಿನ ಔಷಧಿ ${clockKn(t)}ಕ್ಕೆ: ${names(data.next)}.` : `Your next medicine is at ${clock12(t)}: ${names(data.next)}.`;
    }
    return lang === 'kn' ? 'ಇಂದು ಇನ್ನು ಯಾವುದೇ ಔಷಧಿ ಬಾಕಿ ಇಲ್ಲ.' : "Nothing else is scheduled today. All of today's doses are confirmed or recorded.";
  },
  confirmation: (lang, { doses, period }) => {
    const p = lang === 'kn' ? KN_PERIOD[period] : period === 'today' ? "today's" : period;
    if (doses.length === 0) return lang === 'kn' ? `ಇಂದು ${p} ಯಾವುದೇ ಔಷಧಿ ನಿಗದಿಯಾಗಿಲ್ಲ.` : `You have no ${p} medicine scheduled today.`;
    const taken = doses.filter((d) => d.status === DOSE_STATUS.TAKEN);
    const missed = doses.filter((d) => d.status === DOSE_STATUS.MISSED);
    const open = doses.filter((d) => d.status === DOSE_STATUS.DUE || d.status === DOSE_STATUS.UNCONFIRMED);
    const later = doses.filter((d) => d.status === DOSE_STATUS.UPCOMING);
    const parts = [];
    if (taken.length === doses.length) {
      const by = taken[0].loggedBy;
      parts.push(lang === 'kn' ? `ಹೌದು. ನಿಮ್ಮ ${p} ಔಷಧಿ ತೆಗೆದುಕೊಂಡಿರುವುದು ದೃಢಪಟ್ಟಿದೆ: ${names(taken)}.` : `Yes. Your ${p} medicine is confirmed: ${names(taken)}${by ? ` (recorded by ${by})` : ''}.`);
      return parts.join(' ');
    }
    if (open.length) parts.push(lang === 'kn' ? `ಇನ್ನೂ ಇಲ್ಲ. ದೃಢೀಕರಣ ಬಾಕಿ: ${names(open)}.` : `Not yet. Still awaiting confirmation: ${names(open)}.`);
    if (taken.length) parts.push(lang === 'kn' ? `ದೃಢಪಟ್ಟಿದೆ: ${names(taken)}.` : `Already confirmed: ${names(taken)}.`);
    if (missed.length) parts.push(lang === 'kn' ? `ತಪ್ಪಿದೆ ಎಂದು ವರದಿಯಾಗಿದೆ: ${names(missed)}.` : `Reported missed: ${names(missed)}.`);
    if (later.length && !open.length && !taken.length) {
      const t = later[0].time;
      parts.push(lang === 'kn' ? `ನಿಮ್ಮ ${p} ಔಷಧಿ ${clockKn(t)}ಕ್ಕೆ ಇದೆ; ಅದರ ಸಮಯ ಇನ್ನೂ ಬಂದಿಲ್ಲ.` : `Your ${p} medicine is at ${clock12(t)}; it isn't due yet.`);
    } else if (later.length) {
      parts.push(lang === 'kn' ? `ಮುಂದೆ: ${names(later)}.` : `Later today: ${names(later)}.`);
    }
    return parts.join(' ');
  },
  appointment: (lang, { next }) => {
    if (!next) return lang === 'kn' ? 'ಮುಂದಿನ ಯಾವುದೇ ಅಪಾಯಿಂಟ್ಮೆಂಟ್ ದಾಖಲಾಗಿಲ್ಲ.' : 'No upcoming appointment is recorded.';
    return lang === 'kn'
      ? `ನಿಮ್ಮ ಮುಂದಿನ ಅಪಾಯಿಂಟ್ಮೆಂಟ್ ಡಾ. ${next.doctor}${next.specialty ? ` (${next.specialty})` : ''} ಅವರೊಂದಿಗೆ ${formatDate(next.date, 'kn')} ರಂದು ${clockKn(next.time)}ಕ್ಕೆ${next.location ? `, ${next.location}` : ''}.`
      : `Your next appointment is with Dr. ${next.doctor}${next.specialty ? ` (${next.specialty})` : ''} on ${formatDate(next.date, 'en')} at ${clock12(next.time)}${next.location ? `, at ${next.location}` : ''}.`;
  },
  stock: (lang, { low }) => {
    if (low.length === 0) return lang === 'kn' ? 'ಯಾವುದೇ ಔಷಧಿ ಕಡಿಮೆ ಇಲ್ಲ.' : 'No medicine is running low.';
    const items = low.map((m) => (lang === 'kn' ? `${m.name} (${m.stock} ಉಳಿದಿದೆ)` : `${m.name} (${m.stock} left)`)).join(', ');
    return lang === 'kn' ? `ಕಡಿಮೆ ಉಳಿದಿದೆ: ${items}. ಮರುಪೂರಣಕ್ಕೆ ನಿಮ್ಮ ಆರೈಕೆದಾರರಿಗೆ ತಿಳಿಸಿ.` : `Running low: ${items}. Please let your caregiver know about a refill.`;
  },
  contacts: (lang, { contacts }) => {
    if (contacts.length === 0) return lang === 'kn' ? 'ಯಾವುದೇ ಸಂಪರ್ಕ ದಾಖಲಾಗಿಲ್ಲ.' : 'No contacts are recorded yet.';
    const items = contacts.map((c) => `${c.name}${c.phone ? ` ${c.phone}` : ''}`).join(', ');
    return lang === 'kn' ? `ನಿಮ್ಮ ಸಂಪರ್ಕಗಳು: ${items}. ತುರ್ತು ಪರಿಸ್ಥಿತಿಯಲ್ಲಿ 112 ಗೆ ಕರೆ ಮಾಡಿ.` : `Your contacts: ${items}. In an emergency, call 112.`;
  },
  help: (lang) =>
    lang === 'kn'
      ? 'ನಮಸ್ಕಾರ! ನೀವು ಕೇಳಬಹುದು: ಈಗ ಯಾವ ಔಷಧಿ, ಬೆಳಿಗ್ಗೆಯ ಔಷಧಿ ದೃಢಪಟ್ಟಿದೆಯೇ, ಮುಂದಿನ ಡಾಕ್ಟರ್ ಅಪಾಯಿಂಟ್ಮೆಂಟ್ ಯಾವಾಗ, ಅಥವಾ ಯಾವ ಔಷಧಿ ಕಡಿಮೆ ಇದೆ.'
      : 'Namaste! You can ask me which medicine to take now, whether your morning dose is confirmed, when your next doctor appointment is, or what is running low.',
  unknown: (lang) =>
    lang === 'kn'
      ? 'ಕ್ಷಮಿಸಿ, ನಿಮ್ಮ ದಾಖಲೆಗಳಿಂದ ಇದಕ್ಕೆ ಉತ್ತರಿಸಲು ಸಾಧ್ಯವಿಲ್ಲ. ನಿಮ್ಮ ಔಷಧಿಗಳು, ದೃಢೀಕರಣಗಳು, ಅಪಾಯಿಂಟ್ಮೆಂಟ್‌ಗಳು ಮತ್ತು ಸಂಪರ್ಕಗಳ ಬಗ್ಗೆ ಕೇಳಬಹುದು.'
      : "Sorry, I can't answer that from your records. I can help with your medicines, confirmations, appointments and contacts.",
};

const TOOL_FOR = { emergency: 'contacts', medicines: 'medicines', confirmation: 'confirmation', appointment: 'appointment', stock: 'stock', contacts: 'contacts' };

/** Answers a classified question from records. Pure and deterministic. */
function answer(circle, now, { intent, period, language }) {
  const toolName = TOOL_FOR[intent] || null;
  const data = toolName ? tools(circle, now)[toolName](period) : {};
  const source = intent === 'emergency' || intent === 'medical_advice' ? 'safety' : toolName ? 'records' : 'general';
  return { answer: RESPOND[intent](language, data), intent, period, language, source, tool: toolName };
}

module.exports = { INTENTS, PERIODS, detectLanguage, classify, screen, answer };
