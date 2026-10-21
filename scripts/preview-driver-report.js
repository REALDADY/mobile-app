const fs = require('fs/promises');
const path = require('path');
const { createDriverReportService } = require('../src/driver-report-service');

const objects = new Map();
const storage = {
  async getBucket() { return { data: { id: 'qa' }, error: null }; },
  async createBucket() { return { data: {}, error: null }; },
  from() {
    return {
      async download(objectPath) {
        if (!objects.has(objectPath)) return { data: null, error: { message: 'Not found' } };
        return { data: new Blob([objects.get(objectPath)]), error: null };
      },
      async upload(objectPath, value) {
        objects.set(objectPath, Buffer.from(value));
        return { data: { path: objectPath }, error: null };
      },
    };
  },
};

async function main() {
  const service = createDriverReportService({
    supabase: { storage },
    apiBaseUrl: 'http://localhost:5000',
    signingSecret: 'qa-only-signing-secret',
    bucket: 'qa-driver-reports',
  });
  const driver = { id: '00000000-0000-4000-8000-000000000001', name: 'Driver 1' };
  const date = service.dateKey();
  const stops = [
    { orderId: 'ARS-20260827-1001', orderNumber: 'ARS-20260827-1001', customerName: 'Alrawdah Spring', address: 'Villa 14, Al Ghail, Ras Al Khaimah', routeSequence: 1, deliveryInstructions: 'Leave the bottles beside the shaded entrance.' },
    { orderId: 'ARS-20260827-1002', orderNumber: 'ARS-20260827-1002', customerName: 'Maha Al Mansoori', address: 'Mohammed Bin Zayed City, Abu Dhabi', routeSequence: 2 },
  ];
  await service.recordAssignments(driver, stops, `${date}T04:00:00.000Z`);
  await service.recordLocation(driver, { lat: 25.789, lng: 55.943, recorded_at: `${date}T04:02:00.000Z` });
  await service.recordLocation(driver, { lat: 25.775, lng: 55.920, recorded_at: `${date}T04:25:00.000Z` });
  await service.recordCompletion(driver, stops[0], { completedAt: `${date}T05:10:00.000Z`, status: 'DELIVERED', cashCollected: 525 });
  await service.recordCompletion(driver, stops[1], { completedAt: `${date}T06:05:00.000Z`, status: 'DELIVERED' });
  const report = await service.generateReport(driver, date);
  const stored = objects.get(`reports/${driver.id}/${date}.pdf`);
  const output = path.resolve(__dirname, '..', 'tmp', 'pdfs', 'driver-eod-qa.pdf');
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, stored);
  process.stdout.write(JSON.stringify({ output, report }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
