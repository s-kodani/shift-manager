// Static-analysis fixtures only. Never executed.
// ruleid: javascript-dynamic-code
eval(untrusted);
// ruleid: javascript-dynamic-code
new Function(untrusted);
// ruleid: javascript-shell-command
execSync(untrusted);
// ruleid: javascript-disabled-tls
const unsafeAgent = { rejectUnauthorized: false };
// ok: javascript-shell-command
spawn('tool', ['fixed', untrusted], { stdio: 'inherit' });
// ok: javascript-disabled-tls
const safeAgent = { rejectUnauthorized: true };

// ruleid: javascript-unsafe-api-html
element.innerHTML = untrusted;
// ok: javascript-unsafe-api-html
element.textContent = untrusted;
