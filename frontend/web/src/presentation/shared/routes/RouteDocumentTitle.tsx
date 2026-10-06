import { useEffect } from 'react'
import { useLocation } from 'react-router'

import { documentTitleFor } from './screenTitles'

/** 화면을 옮길 때마다 브라우저 제목을 "화면 이름 · GovBiz"로 바꿉니다. 이름은 `screenTitles` 한 곳에서 정합니다. */
export function RouteDocumentTitle() {
  const { pathname, search } = useLocation()
  useEffect(() => {
    document.title = documentTitleFor(pathname, search)
  }, [pathname, search])
  return null
}
