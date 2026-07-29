const fs = require('fs');
const p = 'D:/clerkbox-web-build/src/lib/theme-engine.ts';
let c = fs.readFileSync(p, 'utf8');
c = c.replace("argb(c.onInverseSurface)", "argb(c.inverseOnSurface)");
fs.writeFileSync(p, c);
console.log('fixed:', c.includes('inverseOnSurface'));
