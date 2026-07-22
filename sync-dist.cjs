const fs = require('fs');
const path = require('path');

const root = 'D:\\ClerkBox - 副本';
const appDir = path.join(root, 'release', 'ClerkBox', 'resources', 'app');

function removeRecursive(p) {
    if (!fs.existsSync(p)) return;
    const s = fs.statSync(p);
    if (s.isDirectory()) {
        for (const e of fs.readdirSync(p)) removeRecursive(path.join(p, e));
        fs.rmdirSync(p);
    } else {
        fs.unlinkSync(p);
    }
}

function copyRecursive(s, d) {
    const st = fs.statSync(s);
    if (st.isDirectory()) {
        fs.mkdirSync(d, { recursive: true });
        for (const e of fs.readdirSync(s)) copyRecursive(path.join(s, e), path.join(d, e));
    } else {
        fs.copyFileSync(s, d);
    }
}

const srcDist = path.join(root, 'dist');
const destDist = path.join(appDir, 'dist');
removeRecursive(destDist);
copyRecursive(srcDist, destDist);
console.log('✓ dist 已同步');
