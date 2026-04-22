import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET() {
  try {
    // Determine path to the data directory (assuming it's in the project root's parent folder)
    const dataDir = path.join(process.cwd(), '../data');
    const datPath = path.join(dataDir, 's0221-06082208.dat');
    
    if (!fs.existsSync(datPath)) {
      return NextResponse.json({ error: 'Data file not found' }, { status: 404 });
    }

    const buffer = fs.readFileSync(datPath);
    const numSignals = 8;
    const numSamples = buffer.length / (numSignals * 2); // 16-bit samples (2 bytes each)
    
    // We will extract 3 graphs as requested by the user
    // e.g., ecg_0, ecg_1, sensor_0
    const graph1 = new Array(numSamples);
    const graph2 = new Array(numSamples);
    const graph3 = new Array(numSamples);

    let offset = 0;
    for (let i = 0; i < numSamples; i++) {
      graph1[i] = buffer.readInt16LE(offset); // Ch_0 (ecg_0)
      graph2[i] = buffer.readInt16LE(offset + 2); // Ch_1 (ecg_1)
      graph3[i] = buffer.readInt16LE(offset + 4); // Ch_2 (sensor_0)
      offset += numSignals * 2;
    }

    // Return a subset of samples if the file is massive, 
    // to prevent browsers from freezing. E.g., first 1000 samples for the graph.
    const sliceCount = 1000;
    
    return NextResponse.json({ 
      signals: [
        { name: 'Plot 1 (ECG)', data: graph1.slice(0, sliceCount) },
        { name: 'Plot 2 (PCG / ECG 2)', data: graph2.slice(0, sliceCount) },
        { name: 'Plot 3 (Stroke Frequency / Sensor)', data: graph3.slice(0, sliceCount) }
      ],
      // Return full arrays for accurate pearson calculation on the client side if needed
      raw: {
        graph1: graph1, // returning full 16164 items
        graph2: graph2,
        graph3: graph3
      }
    });

  } catch (error) {
    console.error('API Error:', error);
    return NextResponse.json({ error: 'Failed to process data' }, { status: 500 });
  }
}
