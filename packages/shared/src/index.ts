import { z } from 'zod';

export const responseKind = z.enum(['acknowledged', 'postponed', 'help_requested', 'declined']);
export const channel = z.enum(['speech', 'visual', 'picture', 'assistant']);
export const eventType = z.enum(['door_ring', 'door_left_open', 'tv_on', 'tv_prolonged', 'inactivity', 'fan_changed']);
export const requestKind = z.enum(['water', 'food', 'pain', 'help', 'toilet', 'rest', 'music', 'call_family']);
export type ResponseKind = z.infer<typeof responseKind>;
export type EventType = z.infer<typeof eventType>;
export type RequestKind = z.infer<typeof requestKind>;
