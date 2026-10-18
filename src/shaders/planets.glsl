precision mediump float;

uniform sampler2D uMainSampler; // This will hold your flat 2D map texture
varying vec2 outTexCoord;

uniform float time;
uniform vec2 uResolution;

void main() {
    // Normalize pixel coordinates from [-1, -1] to [1, 1]
    vec2 p = (gl_FragCoord.xy / uResolution.xy) * 2.0 - 1.0;
    
    // Calculate distance from the center of the screen
    float r = dot(p, p);
    
    // Discard pixels outside the sphere's radius (r > 1.0)
    if (r > 1.0) {
        discard; 
    }
    
    // Calculate the 3D Z-depth of the sphere's surface at this point
    float z = sqrt(1.0 - r);
    
    // Calculate Spherical Coordinates (Latitude and Longitude)
    float pi = 3.14159265359;
    float lat = asin(p.y);
    float lon = atan(p.x, z);
    
    // Map spherical coordinates back to a flat [0, 1] 2D texture coordinate
    // The "time * 0.05" creates a constant rotation effect across the flat map
    vec2 uv = vec2((lon / (2.0 * pi)) + 0.5 + (time * 0.05), (lat / pi) + 0.5);
    
    // Fetch the color from your flat map texture
    gl_FragColor = texture2D(uMainSampler, uv);
}
