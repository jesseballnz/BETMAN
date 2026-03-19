#!/usr/bin/env node
/* Fetch & parse sectionals from AucklandRacing/Loveracing race result URL */
const https = require('https');

function fetchHtml(url){
  return new Promise((res,rej)=>{
    https.get(url,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(d));}).on('error',rej);
  });
}

function parseSectionals(html){
  const rows = html.split('table__tr js-table-row').slice(1);
  const out=[];
  for (const chunk of rows){
    // find horse label
    const horseMatch = chunk.match(/table__td_title[\s\S]*?([0-9]+\.[^<]+?)\s*<\/div>/i);
    if (!horseMatch) continue;
    const horse = horseMatch[1].replace(/\s+/g,' ').trim();

    const posMatch = chunk.match(/data-filter-col="pos"[^>]*data-filter-value="([^"]+)"/i);
    const pos = posMatch ? posMatch[1] : null;

    const cols = {};
    const re = /data-filter-col="([^"]+)"[^>]*data-filter-value="([^"]*)"/g;
    let m;
    while ((m = re.exec(chunk)) !== null) {
      cols[m[1]] = m[2];
    }

    out.push({
      horse,
      pos,
      top_speed: cols.speed || null,
      fastest_sect: cols.fastest_sect || null,
      first_400m: cols.first_400m || null,
      race_time: cols.race_time || null,
      l1200: cols.l1200 || null,
      l1100: cols.l1100 || null,
      l1000: cols.l1000 || null,
      l800: cols.l800 || null,
      l600: cols.l600 || null,
      l400: cols.l400 || null,
      l200: cols.l200 || null,
    });
  }
  return out;
}

async function main(){
  const url = process.argv[2];
  if (!url) { console.error('usage: loveracing_sectionals.js <race_url>'); process.exit(2); }
  const html = await fetchHtml(url);
  const rows = parseSectionals(html);
  console.log(JSON.stringify({url, rows}, null, 2));
}

main().catch(err=>{console.error('Error:', err.message); process.exit(1);});
