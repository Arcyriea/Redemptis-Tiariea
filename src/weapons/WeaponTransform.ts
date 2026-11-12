export interface WeaponVector2 {
    readonly x: number;
    readonly y: number;
}

export interface WeaponShipPose {
    readonly x: number;
    readonly y: number;
    readonly rotationDeg: number;
}

export interface WeaponMountTransform {
    /** Position in ship-local pixels. */
    readonly position: WeaponVector2;
    /** Rotation relative to the ship, in degrees. */
    readonly rotationDeg: number;
}

export interface WeaponAttachmentTransform {
    /** Position in mount-local pixels. */
    readonly position: WeaponVector2;
    /** Rotation relative to the mount, in degrees. */
    readonly rotationDeg: number;
}

export interface WeaponMuzzleDefinition {
    /** Position in component-local pixels. */
    readonly position: WeaponVector2;
    /** Direction relative to the component, in degrees. */
    readonly directionDeg: number;
}

export interface ResolvedWeaponMuzzle {
    readonly x: number;
    readonly y: number;
    readonly directionDeg: number;
}

export interface WeaponTransformInput {
    readonly ship: WeaponShipPose;
    readonly mount: WeaponMountTransform;
    readonly attachment: WeaponAttachmentTransform;
    readonly muzzles: readonly WeaponMuzzleDefinition[];
}

const ORIGIN_MUZZLE: WeaponMuzzleDefinition = {
    position: { x: 0, y: 0 },
    directionDeg: 0
};

export function degreesToRadians(degrees: number): number {
    return degrees * (Math.PI / 180);
}

export function resolveWeaponMuzzles(input: WeaponTransformInput): ResolvedWeaponMuzzle[] {
    const shipAngleRad = degreesToRadians(input.ship.rotationDeg);
    const mountAngleRad = degreesToRadians(input.ship.rotationDeg + input.mount.rotationDeg);
    const componentDirectionDeg = input.ship.rotationDeg
        + input.mount.rotationDeg
        + input.attachment.rotationDeg;
    const componentAngleRad = degreesToRadians(componentDirectionDeg);

    const mountPosition = rotate(input.mount.position, shipAngleRad);
    const mountWorld = {
        x: input.ship.x + mountPosition.x,
        y: input.ship.y + mountPosition.y
    };
    const attachmentPosition = rotate(input.attachment.position, mountAngleRad);
    const componentWorld = {
        x: mountWorld.x + attachmentPosition.x,
        y: mountWorld.y + attachmentPosition.y
    };
    const muzzles = input.muzzles.length > 0 ? input.muzzles : [ORIGIN_MUZZLE];

    return muzzles.map((muzzle) => {
        const muzzlePosition = rotate(muzzle.position, componentAngleRad);
        return {
            x: componentWorld.x + muzzlePosition.x,
            y: componentWorld.y + muzzlePosition.y,
            directionDeg: componentDirectionDeg + muzzle.directionDeg
        };
    });
}

export function velocityFromMuzzle(
    directionRad: number,
    speed: number,
    inheritedVelocity: WeaponVector2
): WeaponVector2 {
    return {
        x: Math.cos(directionRad) * speed + inheritedVelocity.x,
        y: Math.sin(directionRad) * speed + inheritedVelocity.y
    };
}

function rotate(point: WeaponVector2, angleRad: number): WeaponVector2 {
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);
    return {
        x: cos * point.x - sin * point.y,
        y: sin * point.x + cos * point.y
    };
}
