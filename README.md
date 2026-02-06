# SB Squares Tracker

A mobile-first web app for tracking your Super Bowl squares pool entries across multiple pools.

## Features

- **Photo-based grid entry** — Snap a photo of your physical grid, align the overlay, and tap your squares
- **Multiple pool types** — Quarters, Half & Final, Every Score, Minute-by-Minute
- **Live ESPN scores** — Auto-polls the ESPN API every 30 seconds during games
- **Auto-win detection** — Instantly see when your squares win based on score digits
- **Multi-pool dashboard** — Track squares and investments across all your pools
- **Manual score fallback** — Enter scores by hand if the live feed isn't available

## Getting Started

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your mobile browser.

## Deploy

This project is configured for one-click deployment on Vercel:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/YOUR_USERNAME/sb-squares-tracker)

## Tech Stack

- React 18
- Vite 6
- ESPN Public API (no key required)