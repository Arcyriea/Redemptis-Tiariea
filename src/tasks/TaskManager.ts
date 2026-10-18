import { Game } from '../core/Game';

export class Task {
    public game: Game;
    public name: string = "";
    public sector: any = null;
    public hint: number = 0;
    public partReward: string = "";
    public speechCompleted: string = "";
    public completed: boolean = false;

    // Objectives queues
    public primaries: any[] = [];
    public secondaries: any[] = [];
    public criticals: any[] = [];
    public specials: any[] = [];

    constructor() {
        this.game = Game.instance;
    }

    init(name: string, sector: any = null) {
        this.name = name;
        this.sector = sector;
        this.completed = false;
        this.primaries = [];
        this.secondaries = [];
        this.criticals = [];
        this.specials = [];
    }

    update() {
        if (this.completed) return;

        // Check primary objectives condition
        let primariesDone = true;
        for (const primary of this.primaries) {
            if (primary && !primary.removeIt) {
                primariesDone = false;
                break;
            }
        }

        if (primariesDone && this.primaries.length > 0) {
            this.completeTask();
        }
    }

    completeTask() {
        this.completed = true;
        this.game.playSound("Reward");

        // Award reward part if specified
        if (this.partReward) {
            this.game.shipPartsData.push(this.partReward);
        }

        // Update task manager
        this.game.taskManager.onTaskCompleted(this);
    }
}

export class TaskManager {
    public game: Game;
    public tasks: Task[] = [];
    public completedTasks: Task[] = [];

    constructor() {
        this.game = Game.instance;
    }

    addTask(task: Task) {
        this.tasks.push(task);
    }

    update() {
        for (let i = this.tasks.length - 1; i >= 0; i--) {
            const task = this.tasks[i];
            task.update();
            if (task.completed) {
                this.tasks.splice(i, 1);
                this.completedTasks.push(task);
            }
        }
    }

    onTaskCompleted(task: Task) {
        console.log(`Task completed: ${task.name}`);
        this.game.uiManager.showNotification(`Task Completed: ${task.name}`);
    }
}