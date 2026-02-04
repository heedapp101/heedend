const AWS = require('aws-sdk');

const filename = '1769189533210-0.5040931981823282-Aswinkrishna%20(4).pdf';
const paths = !filename.includes('private/') 
  ? [filename, `private/${filename}`] 
  : [filename];

console.log('Will try paths:', paths);

const s3 = new AWS.S3({
  endpoint: 'https://27c6cc2575917417ba97cd55e8dd6747.r2.cloudflarestorage.com',
  accessKeyId: '0aa136019a0a0a9fc908a9604d15e055',
  secretAccessKey: '9154479d7802ffc91fe3438fa9ffef942a131e76e0b1e862ea01d5354e89cbd7',
  signatureVersion: 'v4',
  region: 'auto'
});

let completed = 0;
paths.forEach((key, idx) => {
  s3.getObject({ Bucket: 'heedmain', Key: key }, (err, data) => {
    if (err) {
      console.log(`Try ${idx}: ${key} - Failed: ${err.message}`);
    } else {
      console.log(`Try ${idx}: ${key} - Success: ${data.Body.length} bytes`);
    }
    completed++;
    if (completed === paths.length) {
      process.exit(0);
    }
  });
});
