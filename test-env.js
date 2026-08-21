// Quick diagnostic to check environment variables
console.log('Environment check:');
console.log('NETLIFY:', process.env.NETLIFY);
console.log('SITE_ID:', process.env.SITE_ID);
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('import.meta.env.DEV would be:', process.env.NODE_ENV !== 'production');
