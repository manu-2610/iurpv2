const fs = require('fs');

try {
    const json = JSON.parse(fs.readFileSync('./cookies.json', 'utf8'));
    let netscape = "# Netscape HTTP Cookie File\n";
    
    json.forEach(c => {
        const domain = c.domain.startsWith('.') ? c.domain : `.${c.domain}`;
        const httpOnly = c.httpOnly ? "TRUE" : "FALSE";
        const secure = c.secure ? "TRUE" : "FALSE";
        const expires = Math.floor(c.expirationDate || 0);
        netscape += `${domain}\tTRUE\t${c.path}\t${secure}\t${expires}\t${c.name}\t${c.value}\n`;
    });

    fs.writeFileSync('./cookies2.txt', netscape);
    console.log("✅ File 'cookies.txt' (Netscape) generato con successo!");
} catch (e) {
    console.error("Errore nella conversione:", e);
}