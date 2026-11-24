const readline = require('node:readline');
const mapshaper = require('mapshaper');

async function main() {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    const [source, target] = JSON.parse(line);
    // Each call starts with a fresh mapshaper dataset inside the same Node process.
    await mapshaper.runCommands(['-quiet', '-i', source, '-simplify', '7%', 'keep-shapes',
      '-o', 'force', 'format=topojson', 'id-field=GEOID20', 'quantization=1000000', target]);
    process.stdout.write('ok\n');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
