const bcrypt = require("bcryptjs");

const password = process.argv[2];

if (!password) {
    console.log("Usage: node create-password-hash.js YOUR_PASSWORD");
    process.exit(1);
}

const hash = bcrypt.hashSync(password, 12);
console.log(hash);