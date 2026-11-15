import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import {readFileSync} from 'node:fs';
import {nativeResourceProfile} from './scripts/native-resource-profile.mjs';

const checkUrl = process.env.CANCELLATION_NATIVE_CHECK_URL;
const largeCompute=process.env.NATIVE_LARGE_COMPUTE==='1';
const registeredCompute=process.env.NATIVE_REGISTERED_COMPUTE==='1';
const httpCompute=process.env.NATIVE_HTTP_COMPUTE==='1';
const savedCandidate=process.env.NATIVE_SAVED_CANDIDATE==='1';
// Validate the same explicit mode contract in both the launcher and test runner.
// A bounded HTTP run must never silently select the prepared-snapshot test.
const resources=nativeResourceProfile(process.env);
const boundedCompute=resources?.scope==='prepared-snapshot';
const fixturePath=process.env.NATIVE_LARGE_CHECKER_FIXTURE;
if(!fixturePath)throw new Error('Use the owned-container runner for the fictional monthly fixture');
const largeFixture=readFileSync(fixturePath,'utf8');
if (!checkUrl || !/^http:\/\/127\.0\.0\.1:\d+$/.test(checkUrl))
  throw new Error(
    "Use npm run test:cancellation-native for a loopback-only native checker",
  );

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./infra/wrangler.jsonc" },
      miniflare: {
        // Only the test transport is bridged through Node; checker bytes are real.
        // This avoids workerd's platform-dependent direct socket transport to Docker.
        serviceBindings: {
          LARGE_CHECKER_FIXTURE: async (request) => request.url==='http://large-fixture.local/'&&request.method==='GET' ? new Response(largeFixture,{headers:{'content-type':'application/json'}}) : new Response(null,{status:403}),
          NATIVE_CHECKER: async (request) => {
            const url = new URL(request.url);
            const referenceSolve=url.pathname==='/solve'&&request.headers.get('x-native-reference-solve')==='history-reference-v1';
            if (
              url.origin !== checkUrl ||
              (!['/check',...(largeCompute?['/solve']:[])].includes(url.pathname)&&!referenceSolve) ||
              request.method !== "POST"
            )
              return new Response(null, { status: 403 });
            const response = await fetch(request.url, {
              method: "POST",
              headers: { "content-type": "application/json",...(url.pathname==='/solve'?{'x-optimizer-profile':referenceSolve?'mvp-joint-calendar-fallback-v1':savedCandidate?'mvp-joint-seed-v1':'mvp-joint-v1'}:{}) },
              body: await request.arrayBuffer(),
              signal: AbortSignal.timeout(Math.min(largeCompute ? 150000 : 60000, Math.max(1,Number(request.headers.get('x-native-timeout-ms')??60000)))),
            });
            // Fully consume before returning across the test binding boundary.
            const bytes = await response.arrayBuffer();
            return new Response(bytes, {
              status: response.status,
              headers: {
                "content-type":
                  response.headers.get("content-type") ?? "application/json",
                "content-length": String(bytes.byteLength),
              },
            });
          },
        },
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./infra/migrations"),
          CANCELLATION_NATIVE_CHECK_URL: checkUrl,
          NATIVE_SAVED_CANDIDATE_PROFILE: savedCandidate?'mvp-joint-seed-v1':'',
        },
      },
    })),
  ],
  test: { include: [boundedCompute?"tests/bounded-compute-native/**/*.test.ts":httpCompute?"tests/http-compute-native/**/*.test.ts":registeredCompute?"tests/registered-native/**/*.test.ts":largeCompute?"tests/compute-native/**/*.test.ts":"tests/native/**/*.test.ts"], testTimeout: (registeredCompute||httpCompute)?600000:largeCompute?210000:90000, fileParallelism: false },
});
