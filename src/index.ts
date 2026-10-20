import express from 'express';
import app from '../server/src/index.js';

// Vercel's Express adapter uses this single serverless handler for the existing
// API routes. Static files are built into /public and served by Vercel's CDN.
void express;
export default app;
