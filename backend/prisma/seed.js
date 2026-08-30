const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding employees...');

  const employees = [
    {
      email: 'admin@acschennai.com',
      password: await bcrypt.hash('admin123', 10),
      name: 'Admin User',
      designation: 'HR Manager',
      department: 'Human Resources',
      isAdmin: true,
    },
    {
      email: 'employee1@acschennai.com',
      password: await bcrypt.hash('emp123', 10),
      name: 'Rajesh Kumar',
      designation: 'Civil Engineer',
      department: 'Engineering',
    },
    {
      email: 'employee2@acschennai.com',
      password: await bcrypt.hash('emp123', 10),
      name: 'Priya Sharma',
      designation: 'Project Coordinator',
      department: 'Operations',
    },
    {
      email: 'employee3@acschennai.com',
      password: await bcrypt.hash('emp123', 10),
      name: 'Vikram Singh',
      designation: 'Site Supervisor',
      department: 'Site Operations',
    },
  ];

  for (const emp of employees) {
    await prisma.employee.upsert({
      where: { email: emp.email },
      // Spread the data so re-running seed fixes the admin's isAdmin
      // and refreshes bcrypt hashes (previous seed left admin as
      // isAdmin=false because update:{} skipped it).
      update: emp,
      create: emp,
    });
    console.log(`  Created/verified: ${emp.email}`);
  }

  console.log('Seed complete!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
