# ניהול יום בחירות

אפליקציית Next.js לסינון ומיון אשכולות קלפי (כנסת 25) לפי אחוז הצבעה ואחוז ימין, עם מפת נקודות.

## סטאק
- Next.js (App Router) על Vercel
- Neon Postgres
- Leaflet + OpenStreetMap

## פיתוח מקומי
```bash
cd election-day
cp .env.example .env.local   # אם קיים; או הגדר DATABASE_URL
npm install
npm run seed
npm run dev
```

ימין = `ט` + `מחל` + `שס` + `ג`. ברירת מחדל: ימין ≥ 70%, הצבעה &lt; 60%.

## זריעת נתונים
`npm run seed` טוען `data/clusters.json` ו-`data/settlement_coords.json` ל-Neon.
