const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const PRODUCTS = [
  {
    id: '5gal',
    name: '5-Gallon Bottle',
    description: 'Alrawdah Springs — Refillable',
    imageUrl: 'bottel.png',
    price: 14,
    is5Gallon: true,
    depositRequired: 30,
    stock: 100,
  },
  {
    id: '1.5L',
    name: '1.5L Bottle',
    description: 'Pack × 6',
    imageUrl: '1.5L.png',
    price: 9,
    stock: 100,
  },
  {
    id: '500ml',
    name: '500ml Bottle',
    description: 'Pack × 24',
    imageUrl: '500ml.png',
    price: 12,
    stock: 100,
  },
  {
    id: '250ml',
    name: '250ml Bottle',
    description: 'Pack × 24',
    imageUrl: '250ml.png',
    price: 15,
    stock: 100,
  },
  {
    id: '200ml',
    name: '200ml Bottle',
    description: 'Pack × 24',
    imageUrl: '200ml.png',
    price: 11,
    stock: 100,
  },
  {
    id: '150ml',
    name: '150ml Bottle',
    description: 'Pack × 40',
    imageUrl: '150ml.png',
    price: 10,
    stock: 100,
  },
];

async function main() {
  console.log('Seeding products...');
  for (const p of PRODUCTS) {
    await prisma.product.upsert({
      where: { id: p.id },
      update: p,
      create: p,
    });
  }
  console.log('Seeding completed.');
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
