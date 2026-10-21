import { defineConfig } from 'vite';

// GitHub Pages serves the site from a sub-path (/time-globe/); the deploy workflow sets BASE_PATH.
const base = process.env.BASE_PATH ? `${process.env.BASE_PATH.replace(/\/$/, '')}/` : '/';

export default defineConfig({ base });
