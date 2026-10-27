import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
const features = [];
for (const file of readdirSync('spec').filter(file => /^\d\d-/.test(file)).sort()) {
  const text = readFileSync(`spec/${file}`,'utf8');
  const module = text.split('\n')[0].replace(/^# /,'');
  for (const line of text.split('\n')) {
    const match = line.match(/^\| ([A-Z]+-\d\d) \| (.*?) \| (.*?) \| ([CEA]) \|$/);
    if (match) features.push({ id: match[1],name: match[2],requirement: match[3],module,stage: match[4] });
  }
}
if (features.length !== 270 || new Set(features.map(feature => feature.id)).size !== 270) throw Error('Feature ownership mismatch');
mkdirSync('clients/Shared/Resources',{ recursive: true });
writeFileSync('clients/Shared/Resources/features.json',JSON.stringify(features,null,2)+'\n');
console.log(`Generated ${features.length} feature records from specifications`);
