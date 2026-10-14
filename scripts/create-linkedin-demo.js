#!/usr/bin/env node
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const frames = path.join(repo, '.tmp-linkedin-frames');
const outputDir = path.join(repo, 'docs', 'assets');
const width = 1080, height = 1080, fps = 30, total = 150;

const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const clamp = value => Math.max(0, Math.min(1, value));
const ease = value => value < 0.5 ? 2 * value * value : 1 - ((-2 * value + 2) ** 2) / 2;
const opacity = (frame, start, end) => clamp((frame - start) / (end - start));
const card = (x, y, w, h, title, subtitle, accent, alpha = 1) => `
  <g opacity="${alpha}" transform="translate(${x} ${y})">
    <rect width="${w}" height="${h}" rx="28" fill="#111c2e" stroke="${accent}" stroke-opacity=".58" stroke-width="2"/>
    <circle cx="38" cy="42" r="14" fill="${accent}"/>
    <text x="70" y="49" class="card-title">${esc(title)}</text>
    <text x="28" y="92" class="card-subtitle">${esc(subtitle)}</text>
  </g>`;

function svg(frame) {
  const scene = Math.floor(frame / 45);
  const local = (frame % 45) / 45;
  const pulse = 1 + Math.sin(frame / 5) * .025;
  let content = '';
  if (scene === 0) {
    const a = ease(opacity(frame, 3, 22));
    content = `<g opacity="${a}" transform="translate(540 500) scale(${pulse}) translate(-540 -500)">
      <circle cx="540" cy="410" r="92" fill="#162b48" stroke="#72d7ff" stroke-width="3"/>
      <path d="M540 335l18 55 55 20-55 20-18 55-18-55-55-20 55-20z" fill="#8ae5ff"/>
      <text x="540" y="590" text-anchor="middle" class="hero">NexusIDE</text>
      <text x="540" y="640" text-anchor="middle" class="tagline">One runtime. Any agent. Any model.</text>
    </g>`;
  } else if (scene === 1) {
    const a = ease(opacity(frame - 45, 0, 18));
    content = `<g opacity="${a}">
      <text x="78" y="150" class="eyebrow">BUILD A TEAM, NOT JUST A CHAT</text>
      <text x="78" y="215" class="heading">Specialized agents for every step.</text>
      ${card(78, 290, 420, 150, 'Architect', 'Plans the approach', '#8ae5ff', ease(opacity(frame - 45, 3, 18)))}
      ${card(582, 290, 420, 150, 'Coder', 'Implements the change', '#b9a2ff', ease(opacity(frame - 45, 9, 24)))}
      ${card(78, 490, 420, 150, 'Researcher', 'Finds and cites evidence', '#70e0b0', ease(opacity(frame - 45, 15, 30)))}
      ${card(582, 490, 420, 150, 'Reviewer', 'Checks quality and risk', '#ff9c9c', ease(opacity(frame - 45, 21, 36)))}
      <path d="M498 365h84M498 565h84" stroke="#6f8baa" stroke-width="3" stroke-dasharray="8 10"/>
    </g>`;
  } else if (scene === 2) {
    const a = ease(opacity(frame - 90, 0, 16));
    content = `<g opacity="${a}">
      <text x="78" y="150" class="eyebrow">ROUTE THE WORK WHERE IT FITS</text>
      <text x="78" y="215" class="heading">Multiple accounts. Multiple models.</text>
      ${card(78, 300, 924, 132, 'OpenAI · Account 1', 'GPT model selected for implementation', '#8ae5ff', ease(opacity(frame - 90, 3, 16)))}
      ${card(78, 470, 924, 132, 'OpenAI · Account 2', 'Separate quota and credentials', '#b9a2ff', ease(opacity(frame - 90, 12, 25)))}
      ${card(78, 640, 924, 132, 'Ollama · Local', 'Private work stays on your machine', '#70e0b0', ease(opacity(frame - 90, 21, 34)))}
      <text x="78" y="860" class="small-note">Also works with Anthropic, Gemini, DeepSeek, xAI, Qwen, and compatible providers.</text>
    </g>`;
  } else {
    const a = ease(opacity(frame - 135, 0, 14));
    const progress = ease(clamp(local));
    content = `<g opacity="${a}">
      <text x="78" y="150" class="eyebrow">FROM IDEA TO VERIFIED CHANGE</text>
      <text x="78" y="215" class="heading">A shared runtime for your workflow.</text>
      <path d="M150 475H930" stroke="#2f4964" stroke-width="8" stroke-linecap="round"/>
      <path d="M150 475H${150 + 780 * progress}" stroke="#8ae5ff" stroke-width="8" stroke-linecap="round"/>
      ${['Plan', 'Research', 'Build', 'Test', 'Review'].map((label, i) => {
        const x = 150 + i * 195, active = progress >= i / 4;
        return `<circle cx="${x}" cy="475" r="24" fill="${active ? '#8ae5ff' : '#1d3149'}" stroke="#8ae5ff" stroke-width="3"/><text x="${x}" y="555" text-anchor="middle" class="step">${label}</text>`;
      }).join('')}
      <text x="540" y="760" text-anchor="middle" class="tagline">Use your agents from the tools you already love.</text>
      <text x="540" y="840" text-anchor="middle" class="small-note">github.com/reubebe/NexusIDE</text>
    </g>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#08111e"/><stop offset="1" stop-color="#10243b"/></linearGradient></defs>
    <rect width="1080" height="1080" fill="url(#bg)"/>
    <circle cx="940" cy="120" r="240" fill="#194e70" opacity=".12"/><circle cx="80" cy="940" r="260" fill="#4d2c7a" opacity=".10"/>
    <style>.hero{font:700 76px -apple-system,BlinkMacSystemFont,sans-serif;fill:#f4f8ff}.tagline{font:500 30px -apple-system,BlinkMacSystemFont,sans-serif;fill:#b8c9dc}.eyebrow{font:700 18px -apple-system,BlinkMacSystemFont,sans-serif;letter-spacing:3px;fill:#8ae5ff}.heading{font:700 43px -apple-system,BlinkMacSystemFont,sans-serif;fill:#f4f8ff}.card-title{font:700 27px -apple-system,BlinkMacSystemFont,sans-serif;fill:#f4f8ff}.card-subtitle{font:500 22px -apple-system,BlinkMacSystemFont,sans-serif;fill:#a9bdd2}.small-note{font:500 20px -apple-system,BlinkMacSystemFont,sans-serif;fill:#91a8c0}.step{font:600 23px -apple-system,BlinkMacSystemFont,sans-serif;fill:#d5e5f5}</style>
    ${content}<text x="78" y="1000" class="small-note">NexusIDE</text><text x="1002" y="1000" text-anchor="end" class="small-note">LOCAL-FIRST · OPEN SOURCE</text>
  </svg>`;
}

await rm(frames, { recursive: true, force: true });
await mkdir(frames, { recursive: true });
await mkdir(outputDir, { recursive: true });
for (let i = 0; i < total; i += 1) {
  const svgFile = path.join(frames, `frame-${String(i).padStart(4, '0')}.svg`);
  const pngFile = path.join(frames, `frame-${String(i).padStart(4, '0')}.png`);
  await writeFile(svgFile, svg(i));
  const rendered = spawnSync('rsvg-convert', ['-w', String(width), '-h', String(height), '-o', pngFile, svgFile], { stdio: 'inherit' });
  if (rendered.status !== 0) throw new Error('ImageMagick could not render an animation frame.');
}
const mp4 = path.join(outputDir, 'nexus-linkedin-explainer.mp4');
const gif = path.join(outputDir, 'nexus-linkedin-explainer.gif');
for (const args of [
  ['-y', '-framerate', String(fps), '-i', path.join(frames, 'frame-%04d.png'), '-vf', 'format=yuv420p', '-c:v', 'libx264', '-movflags', '+faststart', mp4],
  ['-y', '-framerate', String(fps), '-i', path.join(frames, 'frame-%04d.png'), '-vf', 'fps=10,scale=480:-1:flags=lanczos', '-loop', '0', gif],
]) {
  const result = spawnSync('ffmpeg', args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`ffmpeg failed while creating ${args.at(-1)}`);
}
console.log(JSON.stringify({ mp4, gif }, null, 2));
