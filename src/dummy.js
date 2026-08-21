function 응원봉보내기(응원봉_개수){
    const chatArea = document.querySelector('#write_area');

    if (chatArea.innerText != '사랑해') return true;
    if (chatArea.innerText != '') return false;
    const 응원봉버튼 = document.querySelector('img[title="/응원봉2/"]');
    if (!응원봉버튼) return false;
    for(let i =0; i < 응원봉_개수; ++i)
        응원봉버튼.click();
    const sendBtn = document.querySelector('#btn_send');
    sendBtn.click();
}

function runRandomInterval(fn, t_min, t_max, t_out){
    const start = Date.now();
    const total = t_out * 1000;

    let stopped = false;
    let timer = null;

    function loop(){
        if (stopped) return;

        const elapsed = Date.now() - start;
        const remaining = total - elapsed;

        if (remaining <= 0){
            stopped = true;
            console.log("finished");
            return;
        }

        console.log(`remaining: ${(remaining / 1000).toFixed(2)} sec`);

        const stopFlag = fn();
        if (stopFlag){
            // 구현 필요.

        }

        const delay = Math.random() * (t_max - t_min) + t_min;
        timer = setTimeout(loop, delay);
    }

    loop();

    return {
        stop(){
            stopped = true;
            if (timer) clearTimeout(timer);
            console.log("stopped manually");
        }
    };
}

//사용법
runner = runRandomInterval(
    () => 응원봉보내기(4),
    1450,
    2500,
    3.5*60
);
runner.stop();
