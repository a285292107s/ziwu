precision highp float;

out vec4 outColor;

uniform vec2  uResolution;
uniform float uTime;
uniform vec3  uSunDir;
uniform vec3  uMoonDir;
uniform vec2  uCam;
uniform float uTanHalfFov;
uniform float uExposure;
uniform float uGain;

uniform float uDepth;
uniform float uFloorDrop;
uniform vec3  uBeamDir;
uniform vec3  uAmbDir;
uniform vec3  uBeamTint;
uniform float uBeamPower;
uniform float uAmbPower;
uniform vec3  uAbsorb;
uniform vec3  uScatterNorm;
uniform float uPhaseG;
uniform vec3  uScatterTint;
uniform float uCaustic;
uniform float uSurfaceGlow;
uniform vec3  uSkyAbove;
uniform sampler2D uOcean;
uniform float uInvPatch;

const float N_WATER = 1.333;

const int   STEPS = 18;
const float STEP0 = 0.30;
const float STEP_GROWTH = 1.40;

const vec3 SAND = vec3(0.94, 0.89, 0.78);

const float NET_GAIN = 1.90;
const float MIRROR_BASE = 0.85;
const float MIRROR_GLINT = 0.45;

const float MIRROR_PATH = 1.4;

const float HALO_GAIN = 0.135;
const float HALO_WIDTH = 0.50;
const float GLITTER_CONTRAST = 0.55;
const float GLITTER_MAX = 2.6;
const float RING_GAIN = 0.22;
const float SCAT_LEN = 3.0;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    sum += amp * vnoise(p);
    p = p * 2.03 + vec2(17.3, 9.1);
    amp *= 0.5;
  }
  return sum;
}

vec3 rotateX(vec3 v, float a) {
  float c = cos(a), s = sin(a);
  return vec3(v.x, c * v.y - s * v.z, s * v.y + c * v.z);
}

vec3 rotateY(vec3 v, float a) {
  float c = cos(a), s = sin(a);
  return vec3(c * v.x + s * v.z, v.y, -s * v.x + c * v.z);
}

vec3 rayDir(vec2 fragCoord) {
  vec2 uv = (fragCoord - 0.5 * uResolution) / uResolution.y;
  vec3 d = vec3(uv.x, uv.y, 0.5 / uTanHalfFov);
  d = rotateX(d, -uCam.y);
  d = rotateY(d, uCam.x);
  return normalize(d);
}

vec4 texBS4(sampler2D t, vec2 uv) {
  vec2 ts = vec2(textureSize(t, 0));
  vec2 p = uv * ts - 0.5;
  vec2 f = fract(p);
  p = floor(p);
  vec2 f2 = f * f;
  vec2 f3 = f2 * f;
  vec2 w0 = (-f3 + 3.0 * f2 - 3.0 * f + 1.0) / 6.0;
  vec2 w1 = (3.0 * f3 - 6.0 * f2 + 4.0) / 6.0;
  vec2 w2 = (-3.0 * f3 + 3.0 * f2 + 3.0 * f + 1.0) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 g0 = w0 + w1;
  vec2 g1 = w2 + w3;
  vec2 h0 = (w1 / g0 - 0.5 + p) / ts;
  vec2 h1 = (w3 / g1 + 1.5 + p) / ts;
  return (texture(t, vec2(h0.x, h0.y)) * g0.x + texture(t, vec2(h1.x, h0.y)) * g1.x) * g0.y
    + (texture(t, vec2(h0.x, h1.y)) * g0.x + texture(t, vec2(h1.x, h1.y)) * g1.x) * g1.y;
}

const mat2 OCT_M = mat2(0.8, -0.6, 0.6, 0.8);
const float OCT_SC = 0.41;
const float OCT_WB = 0.10;
const float NET_MAX = 6.0;

vec3 waveField(vec2 p) {
  vec4 A = texBS4(uOcean, p * uInvPatch);
  vec4 B = texBS4(uOcean, (OCT_M * p) * (uInvPatch / OCT_SC) + 0.37);
  vec2 slope = A.yz + OCT_WB * (transpose(OCT_M) * B.yz);
  return vec3(slope, min(A.w * mix(1.0, B.w, OCT_WB), NET_MAX));
}

float fineNet(vec2 p) {
  float a = texBS4(uOcean, p * uInvPatch).w;
  float b = texBS4(uOcean, (OCT_M * p) * (uInvPatch / OCT_SC) + 0.37).w;
  return min(a * mix(1.0, b, OCT_WB), NET_MAX);
}

const int   DROP_MAX = 8;
const float DROP_R = 1.1;
const float DROP_SPREAD = 0.9;
const float DROP_TAU = 3.0;
const float DROP_Q = 5.5;
const float DROP_OMEGA = 4.4;
const float DROP_AMP = 0.07;
const float DROP_CAUSTIC = 0.35;

uniform int uDropCount;
uniform vec4 uDrops[DROP_MAX];

vec3 dropField(vec2 p) {
  vec3 acc = vec3(0.0);
  for (int i = 0; i < DROP_MAX; i++) {
    if (i >= uDropCount)
      break;
    vec4 d = uDrops[i];
    float age = uTime - d.z;
    if (age < 0.0 || age > 3.0 * DROP_TAU)
      continue;
    vec2 dp = p - d.xy;
    float r = length(dp);
    float s2 = DROP_R * DROP_R + DROP_SPREAD * age;
    float decay = exp(-age / DROP_TAU) * d.w;
    if (decay < 1e-4)
      continue;
    decay *= DROP_AMP;
    float g = exp(-r * r / (2.0 * s2));
    float ph = DROP_Q * r - DROP_OMEGA * age;
    float sn = sin(ph);
    float cs = cos(ph);
    acc.xy += g * (-r / s2 * sn + DROP_Q * cs) * (dp / max(r, 1e-4)) * decay;
    acc.z += g * ((r * r / (s2 * s2) - 2.0 / s2 - DROP_Q * DROP_Q) * sn
      + DROP_Q * (1.0 / max(r, 1e-4) - 2.0 * r / s2) * cs) * decay;
  }
  return acc;
}

vec3 waterVolume(vec3 dir, float limit, out float marched) {
  vec3 sumAmb = vec3(0.0);
  float t = 0.0;
  float ds = STEP0;

  float aRef = 1.0 / SCAT_LEN;

  float g = clamp(uPhaseG, 0.0, 0.95);
  float cosS = dot(dir, -uBeamDir);
  float denom = max(1.0 + g * g - 2.0 * g * cosS, 1e-4);
  float phase = (1.0 - g * g) / (denom * sqrt(denom));
  const float PHASE_STRENGTH = 0.25;
  float dirW = mix(1.0, clamp(phase, 0.0, 3.0), PHASE_STRENGTH);

  for (int i = 0; i < STEPS; i++) {
    if (t >= limit) break;
    ds = min(ds, limit - t);
    vec3 p = vec3(0.0, -uDepth, 0.0) + dir * (t + ds * 0.5);
    if (p.y > 0.0) break;

    float ambLen = p.y / uAmbDir.y;

    sumAmb += exp(-uAbsorb * ambLen) * exp(-aRef * t) * ds;

    t += ds;
    ds *= STEP_GROWTH;
  }

  marched = t;
  return uScatterTint * (sumAmb * aRef) * uAmbPower * uScatterNorm * dirW;
}

float nzFade(vec2 p, float scale) {
  float cell = 1.0 / max(scale, 1e-5);
  float px = fwidth(p.x) + fwidth(p.y);
  return mix(0.5, vnoise(p * scale), smoothstep(1.2, 3.0, cell / max(px, 1e-5)));
}

vec3 seaFloor(vec3 p, vec3 dir, float dist, float alive) {
  float dune = clamp(fbm(p.xz * 0.012 + 31.0, 3) * 1.7 + 0.15, 0.0, 1.0);

  float markPhase = dot(p.xz, vec2(0.93, 0.37)) * 16.0 + 3.0 * nzFade(p.xz, 0.8);
  float markFade = smoothstep(0.6, 2.4, 1.0 / max(fwidth(p.x) + fwidth(p.z), 1e-5) / 16.0);
  float marks = 0.5 + 0.5 * sin(markPhase) * markFade;
  float hgt = clamp(0.55 * dune + 0.30 * (nzFade(p.xz, 2.5) - 0.5) * 2.0 + 0.18 * marks, 0.0, 1.0);
  float coarse = smoothstep(0.42, 0.62, nzFade(p.xz * 0.21 + 40.0, 1.0));
  float sandM = smoothstep(hgt + 0.02, hgt + 0.16, (nzFade(p.xz * 0.16 + 3.0, 1.0) - 0.46) * 1.6);
  float big = nzFade(p.xz, 0.45) * 0.65 + nzFade(p.xz, 1.3) * 0.35;
  float weed = smoothstep(0.55, 0.85, nzFade(p.xz, 0.32));

  vec3 alb = SAND * mix(0.58, 1.22, big);
  alb = mix(alb, alb * vec3(0.72, 0.70, 0.62), coarse * (1.0 - sandM));
  alb = mix(alb, alb * vec3(0.48, 0.58, 0.38), weed * 0.65 * (1.0 - sandM));
  alb *= 1.0 - 0.12 * (1.0 - marks) * sandM;

  float beamLen = p.y / uBeamDir.y;
  vec3 beamTrans = exp(-uAbsorb * beamLen);
  vec2 q = p.xz - uBeamDir.xz * beamLen
    + uBeamDir.xz / max(-uBeamDir.y, 1e-3) * (hgt - 0.5) * 0.05;
  float net = uCaustic * (1.0 + (fineNet(q) - 1.0) * alive);
  vec3 drop = dropField(q);
  net *= clamp(1.0 + DROP_CAUSTIC * drop.z, 0.3, 2.5);

  float ao = mix(0.55, 1.0, smoothstep(0.15, 0.60, hgt));

  vec3 lit = uBeamTint * beamTrans * (net * NET_GAIN) * uBeamPower * ao;
  float ambLen = p.y / uAmbDir.y;
  lit += uScatterTint * 0.25 * uAmbPower * exp(-uAbsorb * ambLen) * mix(0.7, 1.0, ao);
  lit *= 0.74 + 0.52 * dune;

  lit *= clamp(-dir.y * 1.9, 0.66, 1.0);
  return lit * alb;
}

vec3 surfaceAt(vec3 dir, vec3 p) {
  vec3 surf = waveField(p.xz);
  vec3 drop = dropField(p.xz);
  vec2 slope = surf.xy + drop.xy;
  float surfNet = min(surf.z * clamp(1.0 + DROP_CAUSTIC * drop.z, 0.3, 2.5), NET_MAX);

  vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));

  float ci = clamp(dot(dir, n), 0.0, 1.0);
  float st = N_WATER * sqrt(max(1.0 - ci * ci, 0.0));
  float ct = sqrt(max(1.0 - st * st, 0.0));
  vec3 o = normalize(N_WATER * dir - (N_WATER * ci - ct) * n);

  float rs = (N_WATER * ci - ct) / max(N_WATER * ci + ct, 1e-4);
  float rp = (ci - N_WATER * ct) / max(ci + N_WATER * ct, 1e-4);
  float mirrorW = st >= 1.0 ? 1.0 : clamp(0.5 * (rs * rs + rp * rp), 0.0, 1.0);

  float windowNet = min(surfNet, 2.0);
  vec3 col = uSkyAbove * (0.14 + 1.30 * pow(clamp(o.y, 0.0, 1.0), 4.0)) * (0.55 + 0.45 * windowNet);

  vec3 sunDir = normalize(uSunDir);
  float sunAng2 = 2.0 * (1.0 - clamp(dot(o, sunDir), -1.0, 1.0));
  float sunUp = smoothstep(0.0, 0.05, sunDir.y);
  vec3 sunTint = mix(uBeamTint, vec3(1.0), 0.35);
  float glitter = clamp(1.0 + (surfNet - 1.0) * GLITTER_CONTRAST, 0.15, GLITTER_MAX);
  col += sunTint * 0.30 * exp(-sunAng2 / (0.133 * 0.133)) * glitter * sunUp;
  col += uBeamTint * HALO_GAIN * exp(-sunAng2 / (HALO_WIDTH * HALO_WIDTH)) * sunUp;

  vec3 moonDir = normalize(uMoonDir);
  float mang2 = 2.0 * (1.0 - clamp(dot(o, moonDir), -1.0, 1.0));
  vec3 moonTint = mix(uBeamTint, vec3(1.0), 0.30);
  col += moonTint * 0.10 * exp(-mang2 / (0.133 * 0.133)) * glitter
    * smoothstep(0.0, 0.06, moonDir.y);
  col += uBeamTint * 0.075 * exp(-mang2 / (0.62 * 0.62))
    * smoothstep(0.0, 0.06, moonDir.y);

  vec3 mirrorTint = uScatterTint * exp(-uAbsorb * (uDepth * MIRROR_PATH));
  vec3 mirror = mirrorTint * MIRROR_BASE
    + uBeamTint * max(surfNet - 1.0, 0.0) * MIRROR_GLINT;
  col = mix(col, mirror, mirrorW);

  col += uSkyAbove * RING_GAIN * (4.0 * mirrorW * (1.0 - mirrorW))
    * (0.6 + 0.4 * surfNet);

  col += uBeamTint * uSurfaceGlow * min(surfNet, 2.0) * 0.35;
  return col;
}

void main() {
  vec3 dir = rayDir(gl_FragCoord.xy);
  vec3 eye = vec3(0.0, -uDepth, 0.0);

  float v = gl_FragCoord.y / uResolution.y;
  float alive = smoothstep(0.68, 0.88, v);

  float surfaceDist = dir.y > 0.0 ? uDepth / dir.y : 1e9;
  float floorDist = uFloorDrop > 0.0 && dir.y < -1e-4 ? -uFloorDrop / dir.y : 1e9;
  float limit = min(surfaceDist, floorDist);

  float marched = 0.0;
  vec3 col = waterVolume(dir, limit, marched);

  if (marched >= limit && limit < 1e8) {
    vec3 through = exp(-uAbsorb * limit);
    vec3 p = eye + dir * limit;
    if (floorDist <= surfaceDist) col += through * seaFloor(p, dir, limit, alive);
    else col += through * surfaceAt(dir, p);
  }

  col *= uExposure * uGain;

  outColor = vec4(max(col, 0.0), 1.0);
}
