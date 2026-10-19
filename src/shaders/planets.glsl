precision mediump float;

uniform sampler2D uMainSampler;
uniform float time;

varying vec2 outTexCoord;

void main() {
    const float PI = 3.14159265359;

    // Local coordinates, centered on this planet's quad.
    // Flip Y so the top of the quad corresponds to north.
    vec2 p = vec2(
        outTexCoord.x * 2.0 - 1.0,
        1.0 - outTexCoord.y * 2.0
    );

    float r = dot(p, p);

    // Discard pixels outside the circular planet.
    if (r > 1.0) {
        discard;
    }

    // Reconstruct the visible hemisphere.
    float z = sqrt(max(0.0, 1.0 - r));

    // Convert the sphere surface to longitude and latitude.
    float lat = asin(clamp(p.y, -1.0, 1.0));
    float lon = atan(p.x, z);

    // Sample the equirectangular planet map.
    vec2 uv = vec2(
        lon / (2.0 * PI) + 0.5 + time * 0.05,
        0.5 - lat / PI
    );

    // Wrap longitude to keep rotation seamless.
    uv.x = fract(uv.x);

    gl_FragColor = texture2D(uMainSampler, uv);
}