document.addEventListener('DOMContentLoaded', () => {
    const botListTextarea = document.getElementById('botList');
    const saveButton = document.getElementById('save');
    const statusMessage = document.getElementById('status');

    // Load the saved bot list when the page opens
    chrome.storage.local.get(['excludedBots'], (result) => {
        if (result.excludedBots) {
            botListTextarea.value = result.excludedBots.join('\n');
        }
    });

    // Save the bot list when the save button is clicked
    saveButton.addEventListener('click', () => {
        const bots = botListTextarea.value.split('\n').map(s => s.trim()).filter(Boolean);
        chrome.storage.local.set({ excludedBots: bots }, () => {
            statusMessage.textContent = 'Settings saved!';
            statusMessage.style.opacity = 1;
            setTimeout(() => {
                statusMessage.style.opacity = 0;
            }, 2000);
        });
    });
});

