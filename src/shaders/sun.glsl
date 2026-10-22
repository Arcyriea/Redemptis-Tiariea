
precision mediump float;

uniform sampler2D uMainSampler;
uniform float time;

varying vec2 outTexCoord;

void main() {
    const float PI = 3.14159265359;

    // Sphere coordinates and room for the solar corona.
    vec2 p = vec2(
        (outTexCoord.x - 0.5) * 2.8,
        (0.5 - outTexCoord.y) * 2.8
    );

    float r = length(p);

    if (r > 1.2) {
        discard;
    }

    // Reconstruct the visible spherical hemisphere.
    float z = sqrt(max(0.0, 1.0 - r * r));
    float lat = asin(clamp(p.y, -1.0, 1.0));
    float lon = atan(p.x, z);

    // Slowly rotate the sun's surface texture.
    vec2 uv = vec2(
        lon / (2.0 * PI) + 0.5 + time * 0.025,
        0.5 - lat / PI
    );
    uv.x = fract(uv.x);

    vec4 texColor = texture2D(uMainSampler, uv);

    // Animated plasma patterns.
    float turbulence =
        sin(uv.x * 38.0 + time * 1.7 + sin(uv.y * 17.0)) *
        cos(uv.y * 29.0 - time * 1.2);

    float convection =
        sin(uv.x * 19.0 - uv.y * 31.0 + time * 0.8) *
        cos(uv.y * 23.0 + time * 0.6);

    float plasma = clamp(
        0.5 + turbulence * 0.22 + convection * 0.18,
        0.0,
        1.0
    );

    // Warm stellar colors: deep orange to bright golden yellow.
    vec3 darkFire = vec3(0.95, 0.16, 0.015);
    vec3 hotFire  = vec3(1.0, 0.48, 0.035);
    vec3 coreGlow = vec3(1.0, 0.86, 0.42);

    vec3 plasmaColor = mix(darkFire, hotFire, plasma);

    // Preserve the supplied texture's detail while making it emissive.
    vec3 surfaceColor = texColor.rgb * plasmaColor * 1.8;
    surfaceColor = mix(
        surfaceColor,
        coreGlow,
        clamp(texColor.r * 0.35, 0.0, 0.45)
    );

    // Brighten the inner limb of the star.
    float limb = smoothstep(0.65, 1.0, r);
    surfaceColor += vec3(1.0, 0.32, 0.035) * limb * 0.35;

    // Smooth edge for the visible solar disc.
    float edgeAlpha = 1.0 - smoothstep(0.96, 1.0, r);

    // Animated radial corona outside the star.
    float angle = atan(p.y, p.x);

    float rays = 0.5 + 0.5 * sin(
        angle * 24.0 + sin(angle * 7.0) * 2.0 + time * 1.4
    );

    float rayStrength = mix(0.65, 1.0, rays);

    float coronaFalloff =
        1.0 - smoothstep(0.82, 1.2, r);

    float coronaInner =
        smoothstep(0.78, 0.98, r);

    float corona = coronaInner * coronaFalloff
                 * rayStrength * 0.8;

    // Warm glow fringe, fading smoothly into transparency.
    float glowFalloff = 1.0 - smoothstep(0.84, 1.2, r);
    float glow = glowFalloff * 0.32;

    vec3 coronaColor = mix(
        vec3(1.0, 0.12, 0.015),
        vec3(1.0, 0.68, 0.12),
        rays
    );

    vec3 glowColor = vec3(1.0, 0.28, 0.035);

    // Combine the stellar surface and corona.
    vec3 finalColor =
        surfaceColor * edgeAlpha
        + coronaColor * corona
        + glowColor * glow;

    float surfaceAlpha = texColor.a * edgeAlpha;
    float finalAlpha = max(surfaceAlpha, max(corona, glow));

    gl_FragColor = vec4(finalColor, finalAlpha);
}
