on run arguments
    set operation to item 1 of arguments
    tell application "Google Chrome"
        if operation is "open" then
            set expectedURL to "https://new-backstage.zhiyitech.cn" & item 2 of arguments
            if (count of windows) is 0 then
                make new window
                set ownedTab to active tab of front window
                set URL of ownedTab to expectedURL
            else
                set ownedTab to make new tab at end of tabs of front window with properties {URL:expectedURL}
            end if
            return id of ownedTab
        else if operation is "find" then
            set requestedId to item 2 of arguments
            set expectedURL to "https://new-backstage.zhiyitech.cn" & item 3 of arguments
            repeat with windowIndex from 1 to count of windows
                repeat with tabIndex from 1 to count of tabs of window windowIndex
                    set pageURL to URL of tab tabIndex of window windowIndex
                    set actualId to id of tab tabIndex of window windowIndex
                    if (actualId as text) is (requestedId as text) then
                        if pageURL starts with expectedURL then
                            return "[" & windowIndex & "," & tabIndex & "]"
                        else
                            error "已登记页面的地址发生变化，需要检查登录状态"
                        end if
                    end if
                end repeat
            end repeat
            return "null"
        else if operation is "evaluate" then
            set windowIndex to (item 2 of arguments) as integer
            set tabIndex to (item 3 of arguments) as integer
            set sourceCode to item 4 of arguments
            set expectedURL to "https://new-backstage.zhiyitech.cn" & item 5 of arguments
            set pageURL to URL of tab tabIndex of window windowIndex
            if pageURL does not start with expectedURL then
                error "页面地址已变化"
            end if
            return execute tab tabIndex of window windowIndex javascript sourceCode
        end if
    end tell
end run
