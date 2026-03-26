// Script to create the first admin user
// Run with: node create-admin.js

const bcrypt = require('bcryptjs');

async function createAdminUser() {
  const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const question = (query) => new Promise((resolve) => readline.question(query, resolve));

  console.log('Create Admin User');
  console.log('=================\n');

  const email = await question('Email: ');
  const password = await question('Password: ');
  const firstName = await question('First Name: ');
  const lastName = await question('Last Name: ');

  const hashedPassword = await bcrypt.hash(password, 10);

  console.log('\nAdd this user to your database using Prisma Studio:');
  console.log('1. Run: cd backend && npm run prisma:studio');
  console.log('2. Go to User table and add a new record with:');
  console.log('   email:', email);
  console.log('   password:', hashedPassword);
  console.log('   firstName:', firstName);
  console.log('   lastName:', lastName);
  console.log('   role: ADMIN');

  readline.close();
}

createAdminUser().catch(console.error);

