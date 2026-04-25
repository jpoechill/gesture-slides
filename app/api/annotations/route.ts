import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import {
  PER_IMAGE_AGGREGATE_FILENAME,
  PER_IMAGE_BARE_NON_PENCIL_VERSION,
  PER_IMAGE_AGGREGATE_VERSION,
  parsePerImageAggregateJSON,
} from "../../lib/perImageSlide";

export const runtime = "nodejs";

const AGGREGATE_PATH = path.join(process.cwd(), PER_IMAGE_AGGREGATE_FILENAME);

export async function GET() {
  try {
    const text = await fs.readFile(AGGREGATE_PATH, "utf8");
    const parsed = parsePerImageAggregateJSON(text);
    return NextResponse.json(parsed);
  } catch {
    return NextResponse.json({
      images: {},
      bareNonPencilMigrationVersion: PER_IMAGE_BARE_NON_PENCIL_VERSION,
    });
  }
}

export async function PUT(req: Request) {
  try {
    const body = (await req.json()) as unknown;
    const parsed = parsePerImageAggregateJSON(JSON.stringify(body));
    await fs.writeFile(
      AGGREGATE_PATH,
      JSON.stringify(
        {
          version: PER_IMAGE_AGGREGATE_VERSION,
          bareNonPencilMigrationVersion: parsed.bareNonPencilMigrationVersion,
          images: parsed.images,
        },
        null,
        2
      ),
      "utf8"
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "write failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
