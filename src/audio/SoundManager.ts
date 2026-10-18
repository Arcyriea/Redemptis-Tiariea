export class SoundManager {
    public enabled: boolean = true;
    public sounds: Map<string, any> = new Map();

    playSound(name: string) {
        if (!this.enabled) return;
        const sound = this.sounds.get(name);
        if (sound) {
            sound.play();
        }
    }

    update() {
        // Handle channel fading or stop requests
    }
}