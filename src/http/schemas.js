'use strict';

const { z } = require('zod');
const { isValidTimezone } = require('../domain/time');

/**
 * Request validation. Every object schema is `.strict()`, so unexpected fields are
 * rejected (no mass-assignment of things like `id`, `role` or `createdAt`).
 */

const text = (max) => z.string().trim().max(max);
const requiredText = (max) => z.string().trim().min(1, 'Required').max(max);

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM');
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value), 'Invalid date');
const optionalEmail = z
  .union([z.literal(''), z.string().trim().toLowerCase().email('Invalid email').max(254)])
  .optional()
  .transform((value) => value || '');
const pin = z.string().regex(/^\d{6}$/, 'PIN must be exactly 6 digits');
const passcode = z.string().min(8, 'At least 8 characters').max(64);
const circleCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z2-9]{6}$/, 'Circle code is 6 letters/numbers');
const timezone = z.string().max(64).refine(isValidTimezone, 'Unknown timezone');
const id = z.string().regex(/^[a-z]{3}_[A-Za-z0-9_-]{8,24}$/, 'Invalid id');

const createCircle = z
  .object({
    elderName: requiredText(80),
    elderEmail: optionalEmail,
    elderPin: pin,
    sharePasscode: passcode,
    timezone: timezone.optional(),
  })
  .strict();

const login = z.discriminatedUnion('role', [
  z.object({ role: z.literal('elder'), code: circleCode, pin }).strict(),
  z
    .object({
      role: z.enum(['caretaker', 'family']),
      code: circleCode,
      passcode,
      name: requiredText(80),
      email: optionalEmail,
    })
    .strict(),
]);

// Base field rules carry no defaults, so partial updates never overwrite untouched fields.
const medicationBase = {
  name: requiredText(80),
  dosage: text(60),
  instructions: text(300),
  times: z
    .array(time)
    .min(1, 'Add at least one time')
    .max(8)
    .transform((list) => [...new Set(list)].sort()),
  days: z
    .array(z.number().int().min(0).max(6))
    .max(7)
    .transform((list) => [...new Set(list)].sort()),
  startDate: date.nullable(),
  endDate: date.nullable(),
  stock: z.number().int().min(0).max(10000).nullable(),
  refillAt: z.number().int().min(0).max(1000).nullable(),
  active: z.boolean(),
};

const endAfterStart = (m) => !m.startDate || !m.endDate || m.endDate >= m.startDate;
const endAfterStartRule = { message: 'End date must be after start date', path: ['endDate'] };

const medicationCreate = z
  .object({
    ...medicationBase,
    dosage: medicationBase.dosage.default(''),
    instructions: medicationBase.instructions.default(''),
    days: medicationBase.days.default([]),
    startDate: medicationBase.startDate.optional(),
    endDate: medicationBase.endDate.optional(),
    stock: medicationBase.stock.default(null),
    refillAt: medicationBase.refillAt.default(null),
    active: medicationBase.active.default(true),
  })
  .strict()
  .refine(endAfterStart, endAfterStartRule);
const medicationUpdate = z.object(medicationBase).partial().strict().refine(endAfterStart, endAfterStartRule);

const appointmentBase = {
  doctor: requiredText(80),
  specialty: text(60),
  location: text(120),
  date,
  time,
  notes: text(500),
  status: z.enum(['upcoming', 'done', 'cancelled']),
};
const appointmentCreate = z
  .object({
    ...appointmentBase,
    specialty: appointmentBase.specialty.default(''),
    location: appointmentBase.location.default(''),
    notes: appointmentBase.notes.default(''),
    status: appointmentBase.status.default('upcoming'),
  })
  .strict();
const appointmentUpdate = z.object(appointmentBase).partial().strict();

const doseLog = z
  .object({ medId: id, date, time, status: z.enum(['taken', 'missed']), note: text(200).optional() })
  .strict();

const settings = z
  .object({
    requireApproval: z.boolean().optional(),
    upcomingLeadMin: z.number().int().min(0).max(60).optional(),
    followupMin: z.number().int().min(5).max(120).optional(),
    escalatePrimaryMin: z.number().int().min(10).max(240).optional(),
    escalateBackupMin: z.number().int().min(15).max(480).optional(),
    timezone: timezone.optional(),
  })
  .strict();

const rotatePasscode = z.object({ sharePasscode: passcode }).strict();
const notifyPreference = z.object({ notify: z.boolean(), email: optionalEmail }).strict();
const decision = z.object({ approve: z.boolean() }).strict();
const demoRole = z.object({ role: z.enum(['elder', 'caretaker', 'family']).default('elder') }).strict();

const prescriptionImage = z
  .object({
    mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    data: z
      .string()
      .min(100)
      .max(5_600_000, 'Image too large (max ~4 MB)')
      .regex(/^[A-Za-z0-9+/=]+$/, 'Image must be base64 encoded'),
  })
  .strict();

const recoverRequest = z.object({ code: circleCode }).strict();
const recoverVerify = z.object({ code: circleCode, otp: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code from the email'), newPin: pin }).strict();

const slot = z.string().regex(/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/, 'Invalid dose time');
const acknowledge = z.object({ slot, note: text(200).optional() }).strict();
const careNote = z.object({ text: requiredText(500) }).strict();
const taskCreate = z.object({ title: requiredText(120), dueDate: date.nullable().optional(), assigneeId: id.nullable().optional() }).strict();
const taskUpdate = z
  .object({ status: z.enum(['open', 'done']).optional(), assigneeId: id.nullable().optional() })
  .strict()
  .refine((v) => v.status !== undefined || v.assigneeId !== undefined, 'Nothing to update');
const handoverCreate = z.object({ toId: id.nullable().optional(), note: text(500).optional() }).strict();
const responder = z.object({ responder: z.enum(['primary', 'backup', 'none']) }).strict();
const emergency = z
  .object({
    contacts: z
      .array(
        z
          .object({
            name: requiredText(80),
            phone: z.string().trim().regex(/^[+\d][\d\s()-]{4,19}$/, 'Use digits, spaces, + and -'),
            relation: text(40).default(''),
          })
          .strict(),
      )
      .max(5)
      .optional(),
    allergies: text(300).optional(),
    conditions: text(300).optional(),
    bloodGroup: z.enum(['', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']).optional(),
    notes: text(300).optional(),
  })
  .strict();
const emergencyShare = z.object({ hours: z.number().int().min(1).max(72) }).strict();
const companionQuestion = z.object({ text: requiredText(300), language: z.enum(['en', 'kn']).optional() }).strict();
const briefSend = z.object({ period: z.enum(['daily', 'weekly']).default('weekly') }).strict();

module.exports = {
  recoverRequest,
  recoverVerify,
  acknowledge,
  careNote,
  taskCreate,
  taskUpdate,
  handoverCreate,
  responder,
  emergency,
  emergencyShare,
  companionQuestion,
  briefSend,
  createCircle,
  login,
  medicationCreate,
  medicationUpdate,
  appointmentCreate,
  appointmentUpdate,
  doseLog,
  settings,
  rotatePasscode,
  notifyPreference,
  decision,
  demoRole,
  prescriptionImage,
  id,
};
