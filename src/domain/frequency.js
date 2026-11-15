'use strict';

/**
 * Converts prescription frequency notation into clock times. Indian prescriptions
 * commonly use "1-0-1" (morning-afternoon-night) and Latin abbreviations (OD, BD,
 * TDS, QID, HS). Doing this deterministically in code means an AI model never
 * decides the actual dose times on its own.
 */

const SLOT_TIMES = ['08:00', '14:00', '21:00'];
const SLOT_TIMES_FOUR = ['08:00', '13:00', '18:00', '22:00'];

const ABBREVIATIONS = {
  OD: ['08:00'],
  QD: ['08:00'],
  ONCE: ['08:00'],
  BD: ['08:00', '20:00'],
  BID: ['08:00', '20:00'],
  TWICE: ['08:00', '20:00'],
  TDS: ['08:00', '14:00', '20:00'],
  TID: ['08:00', '14:00', '20:00'],
  THRICE: ['08:00', '14:00', '20:00'],
  QID: ['08:00', '12:00', '16:00', '20:00'],
  HS: ['21:00'],
  NIGHT: ['21:00'],
  MORNING: ['08:00'],
};

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function normaliseTime(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{1,2})[:.](\d{2})\s*(am|pm)?$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3]?.toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  return TIME_PATTERN.test(time) ? time : null;
}

function frequencyToTimes(frequency) {
  if (typeof frequency !== 'string') return null;
  const text = frequency.trim().toUpperCase();

  const dashed = text.match(/^(\d)\s*-\s*(\d)\s*-\s*(\d)(?:\s*-\s*(\d))?$/);
  if (dashed) {
    const slots = dashed[4] !== undefined ? SLOT_TIMES_FOUR : SLOT_TIMES;
    const counts = dashed.slice(1, slots.length + 1).map(Number);
    const times = slots.filter((_, i) => counts[i] > 0);
    return times.length > 0 ? times : null;
  }

  for (const [abbreviation, times] of Object.entries(ABBREVIATIONS)) {
    if (new RegExp(`\\b${abbreviation}\\b`).test(text)) return [...times];
  }
  return null;
}

/** Prefer explicit valid times; fall back to parsing the frequency; finally once daily. */
function resolveTimes(times, frequency) {
  const explicit = [...new Set((Array.isArray(times) ? times : []).map(normaliseTime).filter(Boolean))];
  if (explicit.length > 0) return explicit.sort().slice(0, 8);
  return frequencyToTimes(frequency) || ['08:00'];
}

module.exports = { frequencyToTimes, normaliseTime, resolveTimes };
