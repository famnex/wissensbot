import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
for (const folder of ['server', 'scripts', 'ops', 'tests']) {
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (file.endsWith('.mjs'))
        execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    }
  };
  walk(folder);
}
console.log('JavaScript-Syntax geprüft.');
