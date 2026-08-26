class AsyncQueue {
    constructor() {
        this.items = [];
        this.waiters = [];
    }

    push(item) {
        if (this.waiters.length) {
            const waiter = this.waiters.shift();
            waiter.resolve(item);
        } else {
            this.items.push(item);
        }
    }

    take() {
        return new Promise((resolve) => {
            if (this.items.length) {
                resolve(this.items.shift());
            } else {
                this.waiters.push({ resolve });
            }
        });
    }

    get size() {
        return this.items.length;
    }
}

module.exports = AsyncQueue;
