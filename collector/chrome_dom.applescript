on run arguments
    set operation to item 1 of arguments
    tell application "Google Chrome"
        if operation is "open" then
            set ownedTab to make new tab at end of tabs of front window with properties {URL:"https://new-backstage.zhiyitech.cn/fd-plus/generation-records"}
            return id of ownedTab
        else if operation is "find" then
            set requestedId to item 2 of arguments
            repeat with windowIndex from 1 to count of windows
                repeat with tabIndex from 1 to count of tabs of window windowIndex
                    set pageURL to URL of tab tabIndex of window windowIndex
                    set actualId to id of tab tabIndex of window windowIndex
                    if (actualId as text) is (requestedId as text) then
                        if pageURL starts with "https://new-backstage.zhiyitech.cn/fd-plus/generation-records" then
                            return "[" & windowIndex & "," & tabIndex & "]"
                        end if
                    end if
                end repeat
            end repeat
            error "没有找到已经登录的 FD 生成记录页面"
        else if operation is "evaluate" then
            set windowIndex to (item 2 of arguments) as integer
            set tabIndex to (item 3 of arguments) as integer
            set sourceCode to item 4 of arguments
            set pageURL to URL of tab tabIndex of window windowIndex
            if pageURL does not start with "https://new-backstage.zhiyitech.cn/fd-plus/generation-records" then
                error "页面地址已变化"
            end if
            return execute tab tabIndex of window windowIndex javascript sourceCode
        end if
    end tell
end run
