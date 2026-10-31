#!/usr/bin/env node
// Скачивает CC0-ассеты Poly Haven для реалистичного офиса в ~/.agentwatch/assets (в git не кладём).
// Запуск: npm run assets
const fs = require('fs');
const path = require('path');

const OUT = process.env.AGENTWATCH_ASSETS || path.join(require('os').homedir(), '.agentwatch', 'assets');
const MODELS = ['modern_arm_chair_01', 'sofa_03', 'Ottoman_01', 'potted_plant_02', 'potted_plant_04',
  'modern_coffee_table_01', 'bar_chair_round_01', 'desk_lamp_arm_01', 'mid_century_lounge_chair', 'side_table_01'];
const TEXTURES = ['laminate_floor_02', 'oak_veneer_01', 'poly_wool_herringbone', 'plastered_wall_04'];
const HDRIS = ['photo_studio_loft_hall', 'unfinished_office_night'];
const RES = '1k';

const api = async (id) => {
  const r = await fetch(`https://api.polyhaven.com/files/${id}`);
  if (!r.ok) throw new Error(`${id}: ${r.status}`);
  return r.json();
};
async function get(url, file) {
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return false;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  return true;
}

(async () => {
  let n = 0;
  for (const id of MODELS) {
    const g = (await api(id)).gltf[RES].gltf;
    const dir = path.join(OUT, 'models', id);
    n += await get(g.url, path.join(dir, `${id}.gltf`));
    for (const [rel, f] of Object.entries(g.include)) n += await get(f.url, path.join(dir, rel));
    console.log('модель', id);
  }
  for (const id of TEXTURES) {
    const d = await api(id);
    for (const [map, key] of [['diff', 'Diffuse'], ['nor', 'nor_gl'], ['rough', 'Rough']]) {
      const f = d[key]?.[RES]?.jpg;
      if (f) n += await get(f.url, path.join(OUT, 'tex', `${id}_${map}.jpg`));
    }
    console.log('текстура', id);
  }
  for (const id of HDRIS) {
    const f = (await api(id)).hdri[RES].hdr;
    n += await get(f.url, path.join(OUT, 'hdri', `${id}.hdr`));
    console.log('hdri', id);
  }
  console.log(`готово, скачано файлов: ${n}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
