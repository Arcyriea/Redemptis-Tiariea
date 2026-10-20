precision mediump float;

uniform sampler2D uMainSampler;
uniform float time;

varying vec2 outTexCoord;

void main() {
    const float PI = 3.14159265359;

    // Local coordinates, centered on this planet's quad.
    vec2 p = vec2(
        outTexCoord.x * 2.0 - 1.0,
        1.0 - outTexCoord.y * 2.0
    );

    float r = length(p);

    // Discard pixels entirely outside the outer atmospheric glow boundary.
    if (r > 1.2) {
        discard;
    }

    // Reconstruct the visible hemisphere for r <= 1.0.
    float z = sqrt(max(0.0, 1.0 - r * r));
    float lat = asin(clamp(p.y, -1.0, 1.0));
    float lon = atan(p.x, z);

    vec2 uv = vec2(
        lon / (2.0 * PI) + 0.5 + time * 0.05,
        0.5 - lat / PI
    );
    uv.x = fract(uv.x);

    vec4 texColor = texture2D(uMainSampler, uv);

    // Smooth anti-aliased edge blend (smoothstep from r = 0.96 to 1.0).
    float edgeAlpha = 1.0 - smoothstep(0.96, 1.0, r);

    // Atmospheric glow fringe (smoothstep from r = 0.85 outward to 1.2).
    // Uses a cyan/blue space-glow tint (vec4(0.3, 0.7, 1.0)).
    float glow = smoothstep(1.2, 0.85, r) * 0.35;
    vec4 glowColor = vec4(0.3, 0.7, 1.0, 1.0) * glow;

    // Combine planet surface with atmospheric glow
    gl_FragColor = (texColor * edgeAlpha) + glowColor;
}