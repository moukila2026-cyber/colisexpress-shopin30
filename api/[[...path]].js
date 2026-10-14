/*
 * Point d'entrée Vercel : la totalité de /api/* arrive sur cette application
 * Express (routes, sessions et autorisations dans lib/app.js).
 */
export { default } from "../lib/app.js";
